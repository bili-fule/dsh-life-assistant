import { createHash } from 'node:crypto'
import { ROLE_TOOLS } from './team-store.mjs'

// The adapter is a trusted host component, never an object supplied by a model.
// It must launch an isolated native DSH runtime and expose only the supplied
// task-bound callbacks. The main Agent remains free to work while it runs.
export class TeamCoordinator {
  constructor({tasks,adapter,tools,maxConcurrent=2,retry=null,maxResident=4}) {
    if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw Error('并发限制无效')
    this.tasks=tasks;this.adapter=adapter;this.tools=tools;this.maxConcurrent=maxConcurrent;this.running=new Map();this.retry=retry
    // A chat branch keeps its native process and session between messages. The SDK
    // can resume an id inside one process but refuses an existing id in a fresh
    // one, so a resident session is the only way to truly continue the same
    // conversation; the cap and the idle reaper bound what that costs.
    this.resident=new Map();this.maxResident=Math.max(1,Math.min(8,maxResident))
  }
  start(id,{wake=null}={}) {
    if(this.running.size>=this.maxConcurrent)return {started:false,reason:'capacity'}
    // The executor identity is derived from the task, so a later attempt reuses
    // the same DSH home, working directory and native session instead of
    // starting a stranger. It still matches the adapter's id pattern.
    const agentId='worker-'+createHash('sha256').update(id).digest('hex').slice(0,20)
    const {task,view}=this.tasks.claim(id,agentId),controller=new AbortController()
    const generation=['chat','peer'].includes(task.role)?this.tasks.db.prepare('SELECT generation FROM yoyo_team_speakers WHERE target=?').get(view.focus).generation:null
    let conclusion=null,suspended=false
    const invoke=async(name,args)=>{
      if(controller.signal.aborted)throw Error('执行已取消')
      const current=this.tasks.authority(agentId)
      if(name==='finish'){
        if(conclusion)throw Error('任务已经明确结束')
        if(!['completed','abandoned'].includes(args?.decision)||typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>2000)throw Error('需要明确结束决定与理由')
        this.tasks.report(agentId,JSON.stringify({decision:args.decision,reason:args.reason}))
        conclusion=args.decision
        return {decision:conclusion,recorded:true}
      }
      // Suspending is a real state: the run ends here, the process is released and
      // only a genuine new message wakes this same identity and session again.
      if(name==='pause'){
        if(suspended)throw Error('任务已经挂起')
        const paused=this.tasks.pause(agentId,args?.reason)
        suspended=true
        return paused
      }
      if(conclusion&&!['usage','report'].includes(name))throw Error('任务已经明确结束')
      if(suspended&&!['usage','report'].includes(name))throw Error('任务已经挂起')
      const roleTools=ROLE_TOOLS[task.role]??[]
      // A task may narrow the role's toolset, never widen it.
      const allowed=task.toolset?roleTools.filter(name=>JSON.parse(task.toolset).includes(name)):roleTools
      if(!allowed.includes(name))throw Error('角色没有该工具权限')
      if(name==='usage')return this.tasks.recordTokens(agentId,Number(args?.tokens??0),args?.reported!==false)
      if(name==='step'){
        const result=await this.tools.step({agentId})
        // Steering and sibling events arrive at a native boundary, after the
        // budget gate, and the cursor moves only when they are handed over.
        return {...result,steers:this.tasks.takeSteers(agentId),events:this.tasks.drainEvents(id)}
      }
      if(name==='report')return this.tasks.report(agentId,args.body)
      if(name==='evidence')return this.tasks.evidence(agentId,args)
      if(name==='remember')return this.tasks.memoryCandidate(agentId,args)
      if(name==='board')return {evidence:this.tasks.board(current.view.id,{limit:args?.limit})}
      // A branch asks and answers its siblings directly; the host decides who it
      // is, so a task cannot impersonate another one or the subject.
      if(name==='ask')return this.tasks.ask(id,{toTask:args.toTask,question:args.question,baseRevision:args.baseRevision??null,viewId:current.view.id})
      if(name==='answer')return this.tasks.answer(id,{questionEventId:args.question,answer:args.answer,viewId:current.view.id})
      if(name==='events')return {events:this.tasks.activityEvents(current.view.id,{taskId:args?.taskId??null,after:args?.after??0,limit:args?.limit??20}),openQuestions:this.tasks.openQuestions(current.view.id)}
      // Waiting for a sibling is the host's job: the branch sleeps here instead of
      // finishing early or polling with model turns.
      if(name==='wait_event')return this.tasks.waitForEvent(id,{seconds:args?.seconds??20})
      const authorize=()=>{
        if(controller.signal.aborted)throw Error('执行已取消')
        this.tasks.authority(agentId)
        if(name==='send')this.tasks.authorizeSend(agentId,view.focus,generation)
      }
      authorize()
      // send implementations MUST call authorize again at actual dispatch,
      // including queued delivery. Pending I/O cannot retain stale authority.
      const result=await this.tools[name]({args,view:current.view,agentId,taskId:id,authorize,signal:controller.signal})
      authorize()
      return result
    }
    const slot={agentId,controller,promise:null}
    this.running.set(id,slot)
    // A lease can be renewed by the heartbeat, so the deadline re-reads the live
    // authority instead of trusting the value captured at start.
    const deadline=setInterval(()=>{
      try{
        const {task:live}=this.tasks.authority(agentId)
        if(this.tasks.clock()>=live.expires_at)controller.abort(Error('任务期限到达'))
      }catch{controller.abort(Error('任务权限已失效'))}
    },30000)
    deadline.unref?.()
    const runStarted=this.tasks.clock()
    const resident=this.residentRoles().includes(task.role)&&typeof this.adapter.open==='function'
    const attempt=()=>({id,role:task.role,goal:task.goal,expiresAt:task.expires_at,wake})
    slot.promise=Promise.resolve().then(async()=>{
      if(!resident)return this.adapter.run({agentId,task:attempt(),invoke,signal:controller.signal})
      let entry=this.resident.get(id)
      if(!entry||entry.agentId!==agentId){
        if(this.resident.size>=this.maxResident)await this.closeResident(this.oldestResident())
        entry={session:await this.adapter.open({agentId,task:attempt(),invoke,signal:controller.signal}),agentId,lastUsed:this.tasks.clock()}
        this.resident.set(id,entry)
      }
      entry.lastUsed=this.tasks.clock()
      return entry.session.prompt(attempt(),invoke)
    }).then(()=>{
      // Model-response latency of one executor run, kept apart from the event
      // delivery latency the store records at each native boundary.
      this.tasks.metrics?.count('worker_run');this.tasks.metrics?.time('worker_run',this.tasks.clock()-runStarted)
      if(!conclusion){
        const state=this.tasks.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(id)?.state
        // A suspended task ended this run on purpose; anything else that stops
        // without a decision is a failure, not a quiet success.
        if(state==='suspended')return {state:'suspended'}
        throw Error('原生轮次结束但任务没有明确结束决定')
      }
      const state=conclusion==='completed'?'completed':'cancelled'
      this.tasks.finish(agentId,state)
      return {state}
    }).catch(()=>{
      // Raw runtime errors may contain infrastructure paths or credentials.
      // Keep them out of reports and cross-scope orchestration envelopes.
      try{this.tasks.finish(agentId,'blocked')}catch{/* Already revoked or expired. */}
      try{this.tasks.noteFailure(id,this.retry??{})}
      catch{this.tasks.db.prepare("UPDATE yoyo_team_tasks SET state='blocked' WHERE id=? AND agent_id=? AND state IN ('running','waiting')").run(id,agentId)}
      return {state:this.tasks.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(id).state}
    }).finally(()=>{
      clearInterval(deadline);this.running.delete(id)
      // A suspended chat branch keeps its session for the next message; every
      // other ending closes it, so an idle process never lingers unowned.
      const state=this.tasks.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(id)?.state
      if(state!=='suspended')void this.closeResident(id)
    })
    return {started:true,id,agentId}
  }
  residentRoles(){return ['chat','peer']}
  closeResident(id){
    const entry=this.resident.get(id)
    if(!entry)return Promise.resolve(false)
    this.resident.delete(id)
    return Promise.resolve(entry.session?.close?.()).then(()=>true).catch(()=>false)
  }
  closeAllResidents(){return Promise.allSettled([...this.resident.keys()].map(id=>this.closeResident(id)))}
  oldestResident(){
    let oldest=null
    for(const [id,entry] of this.resident)if(oldest===null||entry.lastUsed<this.resident.get(oldest).lastUsed)oldest=id
    return oldest
  }
  // An abandoned session is a cost, not a feature: idle residents are reaped so a
  // forgotten conversation does not keep a process alive forever.
  reapResident({idleMs=900000,now=this.tasks.clock()}={}){
    const closed=[]
    for(const [id,entry] of [...this.resident])if(now-entry.lastUsed>idleMs){closed.push(id);void this.closeResident(id)}
    return closed
  }
  async settle(id){return this.running.get(id)?.promise}
  cancel(id,viewId){
    this.tasks.inspect(id,viewId)
    const slot=this.running.get(id)
    // Fence first, then ask the runtime to stop.
    this.tasks.transaction(()=>{
      this.tasks.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE id=? AND state IN ('ready','running','waiting','suspended')").run(id)
      this.tasks.db.prepare('UPDATE yoyo_team_speakers SET generation=generation+1,expires_at=0 WHERE task_id=?').run(id)
    })
    slot?.controller.abort(Error('任务取消'))
    void this.closeResident(id)
    // Tell the siblings, but never let a notification failure block the fence.
    try{this.tasks.publishEvent({fromTask:id,activityId:this.tasks.db.prepare('SELECT activity_id FROM yoyo_team_tasks WHERE id=?').get(id).activity_id??null,kind:'cancel',body:'任务已被取消',viewId})}catch{/* Revoked or expired work stays cancelled. */}
  }
}
