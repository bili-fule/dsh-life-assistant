import { createHash } from 'node:crypto'
import { TeamStore } from './team-store.mjs'
import { TeamMotivation } from './team-motivation.mjs'
import { TeamCoordinator } from './team-coordinator.mjs'
import { TeamNativeAdapter } from './team-native-adapter.mjs'
import { boundedText } from './scope.mjs'
import { readPublicPage } from './public-web.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { localParts } from './time.mjs'

export const TEAM_TOOLS=['team_overview','team_deliberate','team_delegate','team_inspect','team_cancel','team_takeover','team_review']
export const TEAM_POLICY=`你可以用 team_deliberate 查看关切和团队进展，用 team_delegate 分派聊天或公开研究，自己继续其他活动或一起研究。分派前创建真实的 yoyo_concern，说明为何关心、下一步、完成和停止条件。聊天执行者会在当前窗口直接交流；主 Agent 需要发言前用 team_takeover 接管。研究只能从 public 视图分派，不能把私聊问题洗成公开输入。team_overview 只有安全状态，详情在原资料范围用 team_inspect 查看。执行结果是证据材料，不等于动机已满足；用 team_review 判断继续、调整、等待或放弃。无事可做允许休息，不高频轮询、不制造任务。`

export class TeamHost {
  constructor(social,config) {
    if(!social.separate)throw Error('团队仅用于独立 QQ 主体')
    this.social=social;this.tasks=new TeamStore(social.data);this.motivation=new TeamMotivation(this.tasks,social.motivation??null)
    this.db=social.data.db
    this.db.exec(`CREATE TABLE IF NOT EXISTS yoyo_team_deliveries(
      key TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL,state TEXT NOT NULL,remote_id TEXT);
      CREATE TABLE IF NOT EXISTS yoyo_team_main_outbox(key TEXT PRIMARY KEY,target TEXT NOT NULL,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_notices(task_id TEXT PRIMARY KEY,noticed_at INTEGER NOT NULL);
    `)
    // Process restarts never silently replay an unconfirmed external send.
    this.db.prepare("UPDATE yoyo_team_deliveries SET state='uncertain' WHERE state='sending'").run()
    this.db.prepare("UPDATE yoyo_team_tasks SET state='blocked' WHERE state IN ('running','waiting')").run()
    this.db.prepare('UPDATE yoyo_team_speakers SET expires_at=0,generation=generation+1').run()
    const steps=new Map()
    this.steps=steps
    this.coordinator=new TeamCoordinator({tasks:this.tasks,adapter:new TeamNativeAdapter({...config,persona:()=>social.store.get('yoyo_persona','你是 yoyo，说话自然，有自己的兴趣与打算。')}),maxConcurrent:config.maxConcurrent??2,tools:{
      step:async({agentId})=>{
        const settings=social.store.get('yoyo_settings',{}),day=localParts().date
        const used=this.db.prepare('SELECT steps FROM yoyo_usage WHERE day=?').get(day)?.steps??0
        if(settings.paused||used>=(settings.dailySteps??0)||(steps.get(agentId)??0)>=(config.maxSteps??20))throw Error('执行预算已用尽或主体暂停')
        steps.set(agentId,(steps.get(agentId)??0)+1)
        this.db.prepare('INSERT INTO yoyo_usage(day,steps) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET steps=steps+1').run(day)
        return {allowed:true}
      },
      read:async({args,view})=>{
        const messages=social.data.read(view.id,{after:args.after,limit:Math.min(30,args.limit??20)})
        social.data.markRead(view.id,messages.map(m=>m.id))
        return {messages:messages.map(m=>({...m,text:m.text.slice(0,6000),segments:[]}))}
      },
      recall:async({args,view})=>({memories:social.data.recall(view.id,{query:args.query??''})}),
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
    define('team_delegate','委派一个有动机的聊天或公开研究活动。聊天可直接回复当前窗口；研究仅 public。执行环境独立。可分派属于自己某次选择的活动，但活动体验仍按真实事件去重。',{concernId:{type:'integer'},choiceId:{type:'integer'},role:{type:'string',enum:['chat','research']},goal:{type:'string',maxLength:6000},rationale:{type:'string',maxLength:2000},durationSeconds:{type:'integer',minimum:30,maximum:900}},['concernId','role','goal','rationale'],async(a,e,k,v)=>{
      const task=this.motivation.delegate({...a,key:k,viewId:v.id,expiresAt:Date.now()+1000*(a.durationSeconds??300)})
      // Transfer this window's main lease to the delegated conversation.
      if(a.role==='chat')this.db.prepare('UPDATE yoyo_team_speakers SET expires_at=0,generation=generation+1 WHERE target=? AND agent_id=?').run(v.focus,this.social.sessionId)
      const started=this.coordinator.start(task.id)
      return {id:task.id,...started}
    })
    define('team_inspect','查看当前资料范围内任务的真实状态及增量报告。',{id:{type:'string'}},['id'],async(a,e,k,v)=>({task:this.tasks.inspect(a.id,v.id),reports:this.tasks.reports(a.id,v.id)}))
    define('team_cancel','取消当前范围内任务并撤销其后续发言权。',{id:{type:'string'}},['id'],async(a,e,k,v)=>{this.coordinator.cancel(a.id,v.id);return {cancelled:true}})
    define('team_takeover','接管当前窗口的发言权，使旧执行者后续发送失效。',{},[],async(a,e,k,v)=>({generation:this.tasks.takeover(v.id,this.social.sessionId,Date.now()+900000)}))
    define('team_review','依据报告复查动机；不会自动重启任务或认定关切已完成。',{taskId:{type:'string'},decision:{type:'string',enum:['continue','revise','wait','done','abandon']},reason:{type:'string',maxLength:2000},reportId:{type:'integer'}},['taskId','decision','reason'],async(a,e,k,v)=>this.motivation.review(v.id,a))
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
  tick() {
    const settings=this.social.store.get('yoyo_settings',{})
    if(settings.paused)return
    for(const agentId of this.steps.keys())if(![...this.coordinator.running.values()].some(slot=>slot.agentId===agentId))this.steps.delete(agentId)
    for(const task of this.db.prepare("SELECT id,view_id,expires_at FROM yoyo_team_tasks WHERE state='ready' ORDER BY created_at LIMIT 20").all()){
      if(this.coordinator.running.size>=this.coordinator.maxConcurrent)break
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
