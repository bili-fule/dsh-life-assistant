import { createHash } from 'node:crypto'
import { TeamStore } from './team-store.mjs'
import { TeamMotivation } from './team-motivation.mjs'
import { TeamCoordinator } from './team-coordinator.mjs'
import { TeamNativeAdapter } from './team-native-adapter.mjs'
import { boundedText } from './scope.mjs'
import { readPublicPage } from './public-web.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { localParts } from './time.mjs'

export const TEAM_TOOLS=['team_overview','team_deliberate','team_delegate','team_inspect','team_cancel','team_takeover','team_review','team_steer','team_search','team_memory','team_sources']
export const TEAM_POLICY=`你可以用 team_deliberate 查看关切和团队进展，用 team_delegate 分派聊天或公开研究，自己继续其他活动或一起研究。分派前创建真实的 yoyo_concern，说明为何关心、下一步、完成和停止条件。聊天执行者会在当前窗口直接交流；主 Agent 需要发言前用 team_takeover 接管。研究只能从 public 视图分派，不能把私聊问题洗成公开输入。执行中可用 team_steer 追加一条有界提示，它在执行者下一个原生边界送达一次。执行者可以把自己真正读到的证据放到任务证据板，证据沿用任务来源范围，team_inspect 可查看，team_search 可按线索跨任务检索本窗口可见的证据；重复的同一条来源只算一条，同一来源的不同说法会被标出冲突，team_sources 列出这些来源被读过几次、有几个说法。执行者也能提交记忆候选（team_remember），候选不是记忆：team_memory 列出待决定的候选，采纳时在你自己的视图里重新核对原文，并且只记成执行者报告，不会变成观察。执行结果是证据材料，不等于动机已满足。用 team_review 判断继续、调整、等待或放弃。无事可做允许休息，不高频轮询、不制造任务。`

export class TeamHost {
  constructor(social,config) {
    if(!social.separate)throw Error('团队仅用于独立 QQ 主体')
    this.config=config
    this.social=social;this.tasks=new TeamStore(social.data);this.motivation=new TeamMotivation(this.tasks,social.motivation??null)
    this.memory=social.memoryLayer??null
    this.db=social.data.db
    this.db.exec(`CREATE TABLE IF NOT EXISTS yoyo_team_deliveries(
      key TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL,state TEXT NOT NULL,remote_id TEXT);
      CREATE TABLE IF NOT EXISTS yoyo_team_main_outbox(key TEXT PRIMARY KEY,target TEXT NOT NULL,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_notices(task_id TEXT PRIMARY KEY,noticed_at INTEGER NOT NULL);
    `)
    // Process restarts never silently replay an unconfirmed external send.
    this.db.prepare("UPDATE yoyo_team_deliveries SET state='uncertain' WHERE state='sending'").run()
    this.db.prepare("UPDATE yoyo_team_tasks SET state='blocked',failures=failures+1 WHERE state IN ('running','waiting')").run()
    this.db.prepare('UPDATE yoyo_team_speakers SET expires_at=0,generation=generation+1').run()
    this.coordinator=new TeamCoordinator({tasks:this.tasks,adapter:new TeamNativeAdapter({...config,persona:()=>social.store.get('yoyo_persona','你是 yoyo，说话自然，有自己的兴趣与打算。')}),maxConcurrent:config.maxConcurrent??2,retry:config.retryBlocked?{maxAttempts:config.retryAttempts??1,backoffMs:config.retryDelayMs??60000}:null,tools:{
      step:async({agentId})=>{
        const settings=social.store.get('yoyo_settings',{}),day=localParts().date
        const used=this.db.prepare('SELECT steps FROM yoyo_usage WHERE day=?').get(day)?.steps??0
        if(settings.paused||used>=(settings.dailySteps??0))throw Error('主体暂停或每日执行预算已用尽')
        // Per-task counters are durable, so a restart cannot hand out a fresh
        // budget; the daily budget stays a separate host-wide number.
        const {task:live}=this.tasks.authority(agentId)
        const counter=this.tasks.recordStep(agentId,live.max_steps??config.maxSteps??20)
        // Each metered step also renews the lease within a hard ceiling, so a
        // long but progressing activity is not cut off by its first deadline.
        const lease=this.tasks.renew(agentId,config.leaseMs??900000)
        this.db.prepare('INSERT INTO yoyo_usage(day,steps) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET steps=steps+1').run(day)
        return {allowed:true,step:counter.steps,maxSteps:counter.maxSteps,expiresAt:lease.expiresAt}
      },
      usage:async({agentId,tokens})=>this.tasks.recordTokens(agentId,tokens),
      read:async({args,view})=>{
        const messages=social.data.read(view.id,{after:args.after,limit:Math.min(30,args.limit??20)})
        social.data.markRead(view.id,messages.map(m=>m.id))
        return {messages:messages.map(m=>({...m,text:m.text.slice(0,6000),segments:[]}))}
      },
      recall:async({args,view})=>({memories:social.data.recall(view.id,{query:args.query??''})}),
      // The pack is the only memory the worker starts with: summaries chosen by
      // the subject, scoped to this task's view, never the originals.
      pack:async({agentId,view})=>{
        const {task}=this.tasks.authority(agentId)
        return {pack:this.tasks.memoryPack(task.id,view.id)}
      },
      wait:async({args,view,signal,authorize})=>{
        if(!Number.isSafeInteger(args.after)||args.after<0)throw Error('等待需要真实消息游标')
        const end=Date.now()+Math.max(1,Math.min(60,args.seconds??30))*1000
        do{
          authorize()
          const first=this.db.prepare("SELECT received_at FROM yoyo_events WHERE target=? AND id>? AND kind<>'outgoing' ORDER BY id LIMIT 1").get(view.focus,args.after)
          if(first&&Date.now()>=first.received_at+5000)return {available:true,after:args.after}
          await delay(Math.min(500,Math.max(1,end-Date.now())),undefined,{signal})
        }while(Date.now()<end)
        return {available:false,after:args.after}
      },
      web:async({args,signal})=>readPublicPage(args.url,{signal}),
      send:context=>this.send(context),
    }})
  }
  register(define) {
    define('team_overview','查看团队安全状态，不含其他窗口正文。',{},[],async()=>({tasks:this.tasks.overview()}))
    define('team_deliberate','结合当前范围内关切、分工和证据，自主决定下一步；无事允许休息。',{},[],async(a,e,k,v)=>this.motivation.deliberate(v.id))
    define('team_delegate','委派一个有动机的聊天、公开研究、阅读或核对活动。chat 直接在窗口交流；reader 只读不发言；research 仅 public；verify 只核对证据。可分派属于自己某次选择的活动，但活动体验仍按真实事件去重。可选 recall 给出线索，宿主会从记忆层挑几条摘要装成这个任务的记忆包（只是摘要，执行者仍需核对原文）。',{concernId:{type:'integer'},choiceId:{type:'integer'},role:{type:'string',enum:['chat','research','reader','verify']},goal:{type:'string',maxLength:6000},rationale:{type:'string',maxLength:2000},durationSeconds:{type:'integer',minimum:30,maximum:900},dependsOn:{type:'array',maxItems:3,items:{type:'string',maxLength:60}},maxSteps:{type:'integer',minimum:1,maximum:200},recall:{type:'string',maxLength:300}},['concernId','role','goal','rationale'],async(a,e,k,v)=>{
      const task=this.motivation.delegate({...a,key:k,viewId:v.id,expiresAt:Date.now()+1000*(a.durationSeconds??300)})
      // Transfer this window's main lease to the delegated conversation.
      if(a.role==='chat')this.db.prepare('UPDATE yoyo_team_speakers SET expires_at=0,generation=generation+1 WHERE target=? AND agent_id=?').run(v.focus,this.social.sessionId)
      const pack=this.attachMemoryPack(task.id,v.id,a.recall)
      const started=this.coordinator.start(task.id)
      return {id:task.id,...started,...(pack?{memoryPack:pack}:{})}
    })
    define('team_inspect','查看当前资料范围内任务的真实状态、增量报告、执行者提交的证据板、这个任务的记忆包与用量汇总。',{id:{type:'string'}},['id'],async(a,e,k,v)=>({task:this.tasks.inspect(a.id,v.id),reports:this.tasks.reports(a.id,v.id),evidence:this.tasks.board(v.id,{taskId:a.id}),memoryPack:this.tasks.memoryPack(a.id,v.id),usage:this.tasks.usage(a.id)}))
    define('team_steer','给进行中的任务追加一条有界提示，在执行者下一个原生边界送达一次；不能借此扩大任务权限或改变全局人设。',{id:{type:'string'},message:{type:'string',minLength:1,maxLength:2000}},['id','message'],async(a,e,k,v)=>this.tasks.steer(v.id,{taskId:a.id,message:a.message}))
    define('team_cancel','取消当前范围内任务并撤销其后续发言权。',{id:{type:'string'}},['id'],async(a,e,k,v)=>{this.coordinator.cancel(a.id,v.id);return {cancelled:true}})
    define('team_takeover','接管当前窗口的发言权，使旧执行者后续发送失效。',{},[],async(a,e,k,v)=>({generation:this.tasks.takeover(v.id,this.social.sessionId,Date.now()+900000)}))
    define('team_review','依据报告复查动机；不会自动重启任务或认定关切已完成。',{taskId:{type:'string'},decision:{type:'string',enum:['continue','revise','wait','done','abandon']},reason:{type:'string',maxLength:2000},reportId:{type:'integer'}},['taskId','decision','reason'],async(a,e,k,v)=>this.motivation.review(v.id,a))
    define('team_search','按线索在当前资料范围内检索所有任务证据板里真正读到过的材料，返回任务编号、类型、来源与摘录。只能看到本窗口可见范围，摘录不代表结论已被验证。',{query:{type:'string',minLength:1,maxLength:300},kind:{type:'string',enum:['finding','source','excerpt']},limit:{type:'integer',minimum:1,maximum:20}},['query'],async(a,e,k,v)=>({results:this.tasks.searchEvidence(v.id,{query:a.query,kind:a.kind,limit:a.limit??10})}))
    define('team_sources','查看当前范围内被引用过的来源：被读过几次、有几个不同说法、分别是哪个任务读的。同一来源出现不同说法说明材料互相矛盾，需要自己判断，不能当成已核实。',{limit:{type:'integer',minimum:1,maximum:50}},[],async(a,e,k,v)=>({sources:this.tasks.sourceRegistry(v.id,{limit:a.limit??20})}))
    define('team_memory','查看执行者提交的记忆候选，并决定采纳或不采纳。候选不是记忆：无参数时列出待决定的候选；采纳时由记忆层在你自己的视图里重新核对原文，并且只记成执行者报告，不会变成观察。',{id:{type:'integer',minimum:1},decision:{type:'string',enum:['accept','reject']},reason:{type:'string',maxLength:500},state:{type:'string',enum:['pending','accepted','rejected']},limit:{type:'integer',minimum:1,maximum:50}},[],async(a,e,k,v)=>{
      if(a.id===undefined)return {candidates:this.tasks.memoryCandidates(v.id,{state:a.state??'pending',limit:a.limit??20})}
      const candidate=this.tasks.candidate(v.id,a.id)
      if(a.decision===undefined)return {candidate}
      if(a.decision==='reject')return {candidate:a.id,...this.tasks.decideMemory(v.id,{id:a.id,decision:'reject',reason:a.reason})}
      if(!this.memory)throw Error('记忆层未启用，无法采纳记忆候选')
      const created=this.memory.propose(v.id,this.candidateProposal(candidate))
      return {candidate:a.id,memory:created,...this.tasks.decideMemory(v.id,{id:a.id,decision:'accept',claimId:created.id})}
    })
  }
  // The subject decides what a task may start with: a few scoped summaries, not
  // a memory dump and never the originals. A pack that cannot be built is
  // reported instead of silently pretending the task was briefed.
  attachMemoryPack(taskId,viewId,clue) {
    if(typeof clue!=='string'||!clue.trim())return null
    if(!this.memory)return {error:'记忆层未启用，这个任务没有记忆包'}
    try{
      const recalled=this.memory.recall(viewId,{query:clue,limit:5})
      return this.tasks.writeMemoryPack(taskId,viewId,{clue,items:recalled.results})
    }catch(error){return {error:String(error.message).slice(0,200)}}
  }
  // A worker's own wording never proves itself: on acceptance the memory is
  // rebuilt in the subject's view from the cited originals, and the confidence
  // class is fixed at worker_report so a hand-over can never become an
  // observation just because it was accepted.
  candidateProposal(candidate) {
    const evidence={...candidate.evidence}
    const note='执行者候选（任务 '+candidate.taskId+'）'
    if(candidate.kind==='episode')
      return {kind:'episode',title:candidate.statement,role:'worker_report',what:candidate.context||candidate.statement,note,evidence}
    return {kind:'claim',claimType:candidate.claimType??'fact',statement:candidate.statement,
      context:candidate.context,confidence:'worker_report',note,evidence}
  }
  async send({args,view,agentId,taskId,authorize,signal}) {
    const settings=this.social.store.get('yoyo_settings',{})
    if(settings.paused||settings.observeOnly!==false)throw Error('主体暂停或仅观察')
    const target=this.social.data.target(view.focus,{approved:true})
    if(target.platform!=='qq'||!this.social.qq)throw Error('需要 QQ 发送通道')
    const text=boundedText(args.text,20000),replyId=boundedText(args.replyId,160)
    const key='team-'+createHash('sha256').update(taskId+':'+replyId).digest('hex').slice(0,24)
    const previous=this.db.prepare('SELECT * FROM yoyo_team_deliveries WHERE key=?').get(key)
    if(previous){
      if(previous.body!==text)throw Error('回复编号已用于其他内容')
      return {state:previous.state,messageId:previous.remote_id,replayed:true}
    }
    authorize()
    this.db.prepare("INSERT INTO yoyo_team_deliveries VALUES(?,?,?,'sending',NULL)").run(key,taskId,text)
    try{
      const result=await this.social.qq.send(target,text,key,signal,()=>{
        authorize()
        const live=this.social.store.get('yoyo_settings',{})
        if(live.paused||live.observeOnly!==false)throw Error('发送已暂停')
      })
      if(!result?.messageId)throw Error('发送接口未提供确定回执')
      this.db.prepare("UPDATE yoyo_team_deliveries SET state='sent',remote_id=? WHERE key=?").run(String(result.messageId),key)
      const event=this.social.data.ingest({target:target.handle,sender:target.account,externalId:'sent:'+result.messageId,text,kind:'outgoing',receivedAt:Date.now()})
      this.db.prepare('UPDATE yoyo_events SET read_at=? WHERE id=?').run(Date.now(),event.id)
      return {state:'sent',messageId:result.messageId}
    }catch(error){
      this.db.prepare("UPDATE yoyo_team_deliveries SET state='uncertain' WHERE key=?").run(key)
      throw error
    }
  }
  mainEnqueue(view,key) {
    const lease=this.db.prepare('SELECT * FROM yoyo_team_speakers WHERE target=?').get(view.focus)
    if(lease&&lease.expires_at>Date.now()&&lease.agent_id!==this.social.sessionId)throw Error('聊天执行者持有发言权，请先 team_takeover')
    const generation=lease&&lease.expires_at>Date.now()?lease.generation:this.tasks.takeover(view.id,this.social.sessionId,Date.now()+900000)
    this.tasks.authorizeSend(this.social.sessionId,view.focus,generation)
    const remoteKey='yoyo-'+createHash('sha256').update(key).digest('hex').slice(0,24)
    this.db.prepare('INSERT OR IGNORE INTO yoyo_team_main_outbox VALUES(?,?,?)').run(remoteKey,view.focus,generation)
  }
  mainDispatch(key) {
    const row=this.db.prepare('SELECT * FROM yoyo_team_main_outbox WHERE key=?').get(key)
    if(row)this.tasks.authorizeSend(this.social.sessionId,row.target,row.generation)
  }
  activeWindow(target) {
    return !!this.db.prepare("SELECT 1 FROM yoyo_team_speakers s JOIN yoyo_team_tasks t ON t.id=s.task_id WHERE s.target=? AND s.expires_at>? AND t.state IN ('running','waiting')").get(target,Date.now())
  }
  // Read-only operational view for the admin page: who runs what, how long they
  // have left, why a task is waiting, and what it has spent. No goal, no report
  // text and no private window content.
  status() {
    const tasks=this.db.prepare(`SELECT t.id,t.role,t.state,t.attempt,t.failures,t.retry_at,t.renewed_at,t.expires_at,
      coalesce((SELECT sum(u.steps) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) steps,
      coalesce((SELECT sum(u.tokens) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) tokens,
      coalesce((SELECT max(u.tokens_reported) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) tokensReported,
      (SELECT s.target FROM yoyo_team_speakers s WHERE s.task_id=t.id AND s.expires_at>?) leaseTarget,
      (SELECT s.expires_at FROM yoyo_team_speakers s WHERE s.task_id=t.id AND s.expires_at>?) leaseExpires,
      (SELECT count(*) FROM yoyo_team_reports r WHERE r.task_id=t.id) reports,
      (SELECT count(*) FROM yoyo_team_evidence e WHERE e.task_id=t.id) evidence
      FROM yoyo_team_tasks t ORDER BY t.created_at DESC LIMIT 50`).all(Date.now(),Date.now())
    return {concurrency:{running:this.coordinator.running.size,max:this.coordinator.maxConcurrent},tasks:tasks.map(row=>{
      const depends=this.db.prepare('SELECT depends_on FROM yoyo_team_tasks WHERE id=?').get(row.id).depends_on
      const task={...row,tokensReported:row.tokensReported===1,dependsOn:depends?JSON.parse(depends).length:0}
      return {...task,waitReason:this.waitReason(task)}
    })}
  }
  waitReason(row) {
    if(row.state==='blocked')return row.retry_at?'等待重试':row.failures?'失败，等待复查':'已阻塞'
    if(row.state==='ready')return row.dependsOn?'等待依赖任务':'等待调度'
    if(row.state==='running')return row.leaseExpires?'执行中':'执行中（无发言租约）'
    if(row.state==='waiting')return '等待对方回复'
    return row.state
  }
  tick() {
    const settings=this.social.store.get('yoyo_settings',{})
    if(settings.paused)return
    // Retries are opt-in. A task whose last send is uncertain is never retried.
    if(this.config.retryBlocked)for(const row of this.tasks.resumable({now:Date.now()})){
      try{this.tasks.inspect(row.id,row.view_id);this.tasks.requeue(row.id)}catch{/* Revoked work stays blocked. */}
    }
    for(const task of this.db.prepare("SELECT id,view_id,expires_at,depends_on FROM yoyo_team_tasks WHERE state='ready' ORDER BY created_at LIMIT 20").all()){
      if(this.coordinator.running.size>=this.coordinator.maxConcurrent)break
      // A dependent task waits for its dependencies instead of starting early.
      if(task.depends_on&&!JSON.parse(task.depends_on).every(id=>this.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(id)?.state==='completed'))continue
      try{
        const intent=this.db.prepare('SELECT concern_id FROM yoyo_team_intents WHERE task_id=?').get(task.id)
        const concern=this.social.data.concerns(task.view_id).find(c=>c.id===intent?.concern_id)
        if(!concern||concern.state!=='active'||task.expires_at<=Date.now()){
          this.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE id=?").run(task.id);continue
        }
        this.coordinator.start(task.id)
      }catch{this.db.prepare("UPDATE yoyo_team_tasks SET state='blocked' WHERE id=? AND state='ready'").run(task.id)}
    }
  }
  nextEvent() {
    for(const task of this.db.prepare("SELECT id,view_id,state FROM yoyo_team_tasks WHERE state IN ('completed','blocked') AND id NOT IN (SELECT task_id FROM yoyo_team_notices) ORDER BY created_at LIMIT 20").all()){
      try{return {...task,view:this.social.data.view(task.view_id)}}
      catch{this.acknowledge(task.id)}
    }
    return null
  }
  acknowledge(id){this.db.prepare('INSERT OR IGNORE INTO yoyo_team_notices VALUES(?,?)').run(id,Date.now())}
  stop() {
    for(const slot of this.coordinator.running.values())slot.controller.abort(Error('主服务停止'))
    return Promise.allSettled([...this.coordinator.running.values()].map(s=>s.promise))
  }
}
