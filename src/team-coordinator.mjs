import { randomUUID } from 'node:crypto'

// The adapter is a trusted host component, never an object supplied by a model.
// It must launch an isolated native DSH runtime and expose only the supplied
// task-bound callbacks. The main Agent remains free to work while it runs.
export class TeamCoordinator {
  constructor({tasks,adapter,tools,maxConcurrent=2}) {
    if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw Error('并发限制无效')
    this.tasks=tasks;this.adapter=adapter;this.tools=tools;this.maxConcurrent=maxConcurrent;this.running=new Map()
  }
  start(id) {
    if(this.running.size>=this.maxConcurrent)return {started:false,reason:'capacity'}
    const agentId=randomUUID(),{task,view}=this.tasks.claim(id,agentId),controller=new AbortController()
    const generation=task.role==='chat'?this.tasks.db.prepare('SELECT generation FROM yoyo_team_speakers WHERE target=?').get(view.focus).generation:null
    const invoke=async(name,args)=>{
      if(controller.signal.aborted)throw Error('执行已取消')
      const current=this.tasks.authority(agentId)
      const allowed=task.role==='chat'?['read','recall','send','wait','report','evidence','board','usage','step']:['web','report','evidence','board','usage','step']
      if(!allowed.includes(name))throw Error('角色没有该工具权限')
      if(name==='usage')return this.tasks.recordTokens(agentId,Number(args?.tokens??0))
      if(name==='step'){
        const result=await this.tools.step({agentId})
        // Steering arrives at a native boundary, after the budget gate.
        return {...result,steers:this.tasks.takeSteers(agentId)}
      }
      if(name==='report'){this.tasks.report(agentId,args.body);return {recorded:true}}
      if(name==='evidence')return this.tasks.evidence(agentId,args)
      if(name==='board')return {evidence:this.tasks.board(current.view.id,{limit:args?.limit})}
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
    const deadline=setTimeout(()=>controller.abort(Error('任务期限到达')),Math.min(2147483647,Math.max(1,task.expires_at-this.tasks.clock())))
    slot.promise=Promise.resolve().then(()=>this.adapter.run({
      agentId,task:{id,role:task.role,goal:task.goal,expiresAt:task.expires_at},
      invoke,signal:controller.signal,
    })).then(()=>{
      this.tasks.finish(agentId)
      return {state:'completed'}
    }).catch(()=>{
      // Raw runtime errors may contain infrastructure paths or credentials.
      // Keep them out of reports and cross-scope orchestration envelopes.
      try{this.tasks.finish(agentId,'blocked')}catch{/* Already revoked or expired. */}
      this.tasks.db.prepare("UPDATE yoyo_team_tasks SET state='blocked' WHERE id=? AND agent_id=? AND state IN ('running','waiting')").run(id,agentId)
      return {state:this.tasks.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(id).state}
    }).finally(()=>{clearTimeout(deadline);this.running.delete(id)})
    return {started:true,id}
  }
  async settle(id){return this.running.get(id)?.promise}
  cancel(id,viewId){
    this.tasks.inspect(id,viewId)
    const slot=this.running.get(id)
    // Fence first, then ask the runtime to stop.
    this.tasks.transaction(()=>{
      this.tasks.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE id=? AND state IN ('ready','running','waiting')").run(id)
      this.tasks.db.prepare('UPDATE yoyo_team_speakers SET generation=generation+1,expires_at=0 WHERE task_id=?').run(id)
    })
    slot?.controller.abort(Error('任务取消'))
  }
}
