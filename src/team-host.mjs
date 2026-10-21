import { createHash } from 'node:crypto'
import { TeamStore } from './team-store.mjs'
import { TeamIntents } from './team-intents.mjs'
import { ActivityGraph } from './activity-graph.mjs'
import { BranchFolding } from './branch-folding.mjs'
import { TeamMotivation } from './team-motivation.mjs'
import { TeamCoordinator } from './team-coordinator.mjs'
import { TeamNativeAdapter } from './team-native-adapter.mjs'
import { boundedText, mayRead } from './scope.mjs'
import { readPublicPage } from './public-web.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { localParts } from './time.mjs'

export const TEAM_TOOLS=['team_overview','team_deliberate','team_delegate','team_intent','team_inspect','team_cancel','team_takeover','team_review','team_steer','team_search','team_ask','team_answer','team_events','team_graph','team_expand','team_memory','team_sources','team_source_decide']
export const TEAM_POLICY=`默认分工：你决定意图、方向、优先级和例外，执行者实际推进。读群、浏览网页、跑代码和排障容器默认不在你的工具面里；需要亲自处理时先用 yoyo_takeover 写明理由，完成后 yoyo_handback。接管是例外，不是日常路径。已有聊天活动的后续消息由宿主直接交给那个执行者，不经你逐句转述或逐句批准。需要你决定的只有：超出当前任务的新目标、重要承诺、需要追加执行者、分支之间冲突、持续受阻、目标完成或放弃、调整关注策略。可委派的工作先放进意图队列（team_intent，写明目标、为什么、能力、优先级、依赖与完成条件），宿主会在有空闲额度、依赖完成时启动；没有额度时它排队并保持可见，不要因为排队就自己接手。同一活动同一目的只会有一个排队意图。
你可以用 team_deliberate 查看关切和团队进展，用 team_delegate 分派聊天或公开研究，自己继续其他活动或一起研究。分派前创建真实的 yoyo_concern，说明为何关心、下一步、完成和停止条件。聊天执行者会在当前窗口直接交流；主 Agent 需要发言前用 team_takeover 接管。研究只能从 public 视图分派，不能把私聊问题洗成公开输入。执行中可用 team_steer 追加一条有界提示，它在执行者下一个原生边界送达一次。执行者可以把自己真正读到的证据放到任务证据板，证据沿用任务来源范围，team_inspect 可查看，team_search 可按线索跨任务检索本窗口可见的证据；重复的同一条来源只算一条，同一来源的不同说法会被标出冲突，team_sources 列出这些来源被读过几次、有几个说法。执行者也能提交记忆候选（team_remember），候选不是记忆：team_memory 列出待决定的候选，采纳时在你自己的视图里重新核对原文，并且只记成执行者报告，不会变成观察。执行结果是证据材料，不等于动机已满足。用 team_review 判断继续、调整、等待或放弃。无事可做允许休息，不高频轮询、不制造任务。`

export class TeamHost {
  constructor(social,config) {
    if(!social.separate)throw Error('团队仅用于独立 QQ 主体')
    this.config=config
    this.social=social;this.tasks=new TeamStore(social.data,undefined,social.metrics??null);this.motivation=new TeamMotivation(this.tasks,social.motivation??null)
    this.intents=new TeamIntents(social.data,undefined,social.metrics??null)
    this.graph=new ActivityGraph(social.data,this.tasks,this.intents)
    this.folding=new BranchFolding(social.data,this.tasks,this.intents)
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
        // The counterpart of subject_exec: work a real executor really did.
        social.metrics?.count('executor_step')
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
      // Engineering work runs in the same isolated, networkless runner as the main
      // agent's yoyo_execute. The worker can start a bounded job and read its
      // status; it never gets a shell, host files or the debug container.
      execute:async({args,view,taskId,signal})=>{
        if(!social.executor)throw Error('隔离执行服务未配置')
        const job=await social.executor.start({code:args.code,language:args.language,project:args.project??null,outputs:args.outputs??[]},view,this.executionKey(taskId,args.code),signal)
        this.db.prepare('INSERT OR IGNORE INTO yoyo_jobs(id,run_key,scopes,created_at,view_id,state) VALUES(?,?,?,?,?,?)').run(job.id,this.executionKey(taskId,args.code),JSON.stringify(view.scopes),Date.now(),view.id,job.state)
        return {id:job.id,state:job.state,message:'任务在隔离环境运行，稍后用 team_job 查看结果。'}
      },
      job:async({args,view,signal})=>{
        if(!social.executor)throw Error('隔离执行服务未配置')
        const row=this.db.prepare('SELECT scopes,backend FROM yoyo_jobs WHERE id=?').get(args.id)
        if(row?.backend==='debug')throw Error('独立排障任务不向执行者开放')
        if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('任务不存在或不在当前资料范围')
        return social.executor.call('/status',{id:args.id},signal)
      },
      send:context=>this.send(context),
    }})
    // A peer reuses the subject's own implementations for reads, searches, files,
    // attachments, forwards, public browsing and the memory tools. The bridge only
    // forwards the task's view and a task-scoped receipt key; anything missing from
    // peerTools simply is not available to an executor.
    for(const [name,tool] of [['read','yoyo_read'],['search','yoyo_search'],['message','yoyo_message'],['file','yoyo_file'],
      ['attachment','yoyo_attachment'],['forward','yoyo_forward'],['recall','yoyo_recall'],['web','yoyo_web'],
      ['memory_recall','memory_recall'],['memory_inspect','memory_inspect'],['memory_propose','memory_propose'],
      ['memory_segments','memory_segments'],['memory_generalize','memory_generalize']]){
      // The host's own implementation stays as the fallback for read/recall: a
      // subject that has no peer bridge must not silently lose the ability to give
      // a branch its own window.
      const hostTool=this.coordinator.tools[name]
      this.coordinator.tools[name]=async context=>{
        if(!social.peerTools?.has(tool)){
          if(hostTool&&['read','recall'].includes(name))return hostTool(context)
          throw Error('该工具对执行者未启用')
        }
        const {args,view,agentId,signal,key}=context
        const {task}=this.tasks.authority(agentId)
        const receipt=key??'team-'+createHash('sha256').update(task.id+':'+tool+':'+JSON.stringify(args??null)).digest('hex').slice(0,24)
        return social.peerTools.get(tool)(args,{agent:{id:social.sessionId},signal,callId:receipt},receipt,view)
      }
    }
  }
  register(define) {
    define('team_overview','查看团队安全状态，不含其他窗口正文。',{},[],async()=>({tasks:this.tasks.overview()}))
    define('team_deliberate','结合当前范围内关切、分工和证据，自主决定下一步；无事允许休息。',{},[],async(a,e,k,v)=>this.motivation.deliberate(v.id))
    define('team_delegate','委派一个有动机的聊天、公开研究、阅读、核对、工程或同伴活动。chat 直接在窗口交流；reader 只读不发言；research 仅 public；verify 只核对证据；engineer 只从 public 视图分派，在隔离、无网络的执行环境里跑代码；peer 与你自己几乎同等（同样的阅读、搜索、文件与附件、公开网页、代码执行与记忆工具），但没有控制面：不能分派或取消其他执行者、不能改你的注意力与人设，记忆撤回与排障容器仍只属于你。可分派属于自己某次选择的活动，但活动体验仍按真实事件去重。可选 recall 给出线索，宿主会从记忆层挑几条摘要装成这个任务的记忆包（只是摘要，执行者仍需核对原文）。',{concernId:{type:'integer'},choiceId:{type:'integer'},role:{type:'string',enum:['chat','research','reader','verify','engineer','peer']},goal:{type:'string',maxLength:6000},rationale:{type:'string',maxLength:2000},durationSeconds:{type:'integer',minimum:30,maximum:900},dependsOn:{type:'array',maxItems:3,items:{type:'string',maxLength:60}},maxSteps:{type:'integer',minimum:1,maximum:200},recall:{type:'string',maxLength:300}},['concernId','role','goal','rationale'],async(a,e,k,v)=>{
      const task=this.motivation.delegate({...a,key:k,viewId:v.id,expiresAt:Date.now()+1000*(a.durationSeconds??300)})
      // Transfer this window's main lease to the delegated conversation.
      if(a.role==='chat')this.db.prepare('UPDATE yoyo_team_speakers SET expires_at=0,generation=generation+1 WHERE target=? AND agent_id=?').run(v.focus,this.social.sessionId)
      const pack=this.attachMemoryPack(task.id,v.id,a.recall)
      const started=this.coordinator.start(task.id)
      return {id:task.id,...started,...(pack?{memoryPack:pack}:{})}
    })
    // The queue is the subject's own instrument: it states the piece of work and
    // why, the host decides when it can start. This is what makes "the subject
    // decides, executors advance" observable instead of rhetorical.
    define('team_intent','把一件可委派的工作放进意图队列：活动是持续目标，意图是其中一件可交接的事，执行者是它的一次尝试。写清目标、为什么、需要哪些能力（chat 读群并发言、read 只读、web 研究公开资料、verify 核对证据、code 工程、peer 全能力）、优先级、依赖和完成/停止条件；宿主按优先级加等待时间（每等 5 分钟提一级，最多 20）挑选，并受并发与依赖限制。同一活动同一目的重复创建会复用原意图。不带 goal 时列出队列；带 id 可调整排队中的优先级或开始时间，cancel 则放弃。',{id:{type:'string',maxLength:80},goal:{type:'string',minLength:1,maxLength:6000},why:{type:'string',maxLength:2000},activityId:{type:'string',maxLength:80},concernId:{type:'integer'},capabilities:{type:'array',minItems:1,maxItems:4,items:{type:'string',enum:['chat','read','web','research','verify','code','engineer','peer']}},priority:{type:'integer',minimum:0,maximum:100},notBefore:{type:'integer'},dependsOn:{type:'array',maxItems:4,items:{type:'string',maxLength:80}},doneWhen:{type:'string',maxLength:1500},stopWhen:{type:'string',maxLength:1500},target:{type:'string',maxLength:200},cancel:{type:'boolean'},reason:{type:'string',maxLength:1000}},[],
      async(a,e,k,v)=>{
        if(a.id&&a.cancel)return {intent:this.cancelIntent(a.id,a.reason??'',v)}
        if(a.id)return {intent:this.intents.adjust(a.id,{priority:a.priority,notBefore:a.notBefore})}
        if(!a.goal)return {intents:this.intents.summary({limit:20}),note:'ready 才会被调度；等待原因与已等待时长一并列出。'}
        const intent=this.intents.create({activityId:a.activityId??null,concernId:a.concernId??null,goal:a.goal,why:a.why??'',capabilities:a.capabilities??['peer'],priority:a.priority??0,notBefore:a.notBefore??null,dependsOn:a.dependsOn??[],doneWhen:a.doneWhen??'',stopWhen:a.stopWhen??'',target:a.target??null,viewId:v.id})
        return {intent,...(intent.reused?{note:'同一活动与目的已有排队意图，复用原意图'}:{}),queued:'宿主会在有空闲执行额度且依赖完成时启动它，你不必守着它。'}
      })
    define('team_inspect','查看当前资料范围内任务的真实状态、增量报告、执行者提交的证据板、这个任务的记忆包与用量汇总。',{id:{type:'string'}},['id'],async(a,e,k,v)=>({task:this.tasks.inspect(a.id,v.id),reports:this.tasks.reports(a.id,v.id),evidence:this.tasks.board(v.id,{taskId:a.id}),memoryPack:this.tasks.memoryPack(a.id,v.id),usage:this.tasks.usage(a.id)}))
    define('team_steer','给进行中的任务追加一条有界提示，在执行者下一个原生边界送达一次；不能借此扩大任务权限或改变全局人设。',{id:{type:'string'},message:{type:'string',minLength:1,maxLength:2000}},['id','message'],async(a,e,k,v)=>this.tasks.steer(v.id,{taskId:a.id,message:a.message}))
    define('team_cancel','取消当前范围内任务并撤销其后续发言权。',{id:{type:'string'}},['id'],async(a,e,k,v)=>{this.coordinator.cancel(a.id,v.id);return {cancelled:true}})
    define('team_takeover','接管当前窗口的发言权，使旧执行者后续发送失效。',{},[],async(a,e,k,v)=>({generation:this.tasks.takeover(v.id,this.social.sessionId,Date.now()+900000)}))
    define('team_review','依据报告复查动机；不会自动重启任务或认定关切已完成。',{taskId:{type:'string'},decision:{type:'string',enum:['continue','revise','wait','done','abandon']},reason:{type:'string',maxLength:2000},reportId:{type:'integer'}},['taskId','decision','reason'],async(a,e,k,v)=>this.motivation.review(v.id,a))
    define('team_search','按线索在当前资料范围内检索所有任务证据板里真正读到过的材料，返回任务编号、类型、来源与摘录。只能看到本窗口可见范围，摘录不代表结论已被验证。',{query:{type:'string',minLength:1,maxLength:300},kind:{type:'string',enum:['finding','source','excerpt']},limit:{type:'integer',minimum:1,maximum:20}},['query'],async(a,e,k,v)=>({results:this.tasks.searchEvidence(v.id,{query:a.query,kind:a.kind,limit:a.limit??10})}))
    // Branches already talk to each other through the event bus; the subject can
    // use the same bus to ask one of them directly instead of relaying reports.
    define('team_ask','直接问一个进行中的任务一个问题。问题作为事件立即写入，执行者在下一个原生安全边界收到并可以 team_answer 回答；不需要你转述，也不扩大它的权限。',{id:{type:'string'},question:{type:'string',minLength:1,maxLength:2000}},['id','question'],async(a,e,k,v)=>({...this.tasks.ask(null,{toTask:a.id,question:a.question,viewId:v.id}),note:'问题已写入事件；执行者在下一个原生边界收到。等待期间可以做别的事。'}))
    define('team_answer','回答执行者或另一个分支提出的问题；引用原问题编号，答复作为事件回到提问方。',{question:{type:'string',minLength:1,maxLength:80},answer:{type:'string',minLength:1,maxLength:2000}},['question','answer'],async(a,e,k,v)=>this.tasks.answer(null,{questionEventId:a.question,answer:a.answer,viewId:v.id}))
    define('team_events','查看当前资料范围内同一活动/任务的事件流（发现、提问、答复、进展、方向变化、受阻、完成、取消）与仍未回答的问题，用于判断分支之间是否真的在交换进展。',{taskId:{type:'string'},activityId:{type:'string'},after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}},[],async(a,e,k,v)=>({events:this.tasks.activityEvents(v.id,{taskId:a.taskId??null,activityId:a.activityId??null,after:a.after??0,limit:a.limit??20}),openQuestions:this.tasks.openQuestions(v.id,{activityId:a.activityId??null})}))
    define('team_sources','查看当前范围内被引用过的来源：被读过几次、有几个不同说法、分别是哪个任务读的。同一来源出现不同说法说明材料互相矛盾，需要自己判断，不能当成已核实。',{limit:{type:'integer',minimum:1,maximum:50}},[],async(a,e,k,v)=>({sources:this.tasks.sourceRegistry(v.id,{limit:a.limit??20})}))
    // Five questions the subject actually asks, answered from an index instead of
    // rereading every branch: why, what changed direction, who verified, what is
    // still unknown, what the conclusion rests on.
    define('team_graph','查看活动图：为什么做这件事、哪次改变改变了方向、谁验证过、还缺什么、当前结论依赖什么。可按 activityId 限定。这里是索引与引用，正文仍在证据板、事件和裁定里；图里没有模型的隐藏推理。',{activityId:{type:'string',maxLength:80},limit:{type:'integer',minimum:1,maximum:20}},[],async(a,e,k,v)=>({...this.graph.why(v.id,{activityId:a.activityId??null,limit:a.limit??8})}))
    define('team_expand','展开一个已折叠的冷分支：摘要加上它引用的真实报告、证据与事件编号。摘要本身不是新事实，要当依据必须回到原始记录。',{id:{type:'string',minLength:1,maxLength:80}},[],async(a,e,k,v)=>({...this.folding.expand(v.id,a.id)}))
    // Resolving a contradiction stays a subject decision: both readings are kept
    // as history and the ruling is appended with its reason and shared as event.
    define('team_source_decide','对互相矛盾的来源做一次明确裁定：verified 需要写明采纳哪一种说法，refuted 表示认定不可信，unresolved 表示暂时不裁定。原始说法都保留，裁定只追加并说明理由，同时写入事件让正在工作的分支知道。',{source:{type:'string',minLength:1,maxLength:500},decision:{type:'string',enum:['verified','refuted','unresolved']},chosenBody:{type:'string',maxLength:2000},reason:{type:'string',minLength:1,maxLength:1000}},['source','decision','reason'],async(a,e,k,v)=>this.tasks.decideSource(v.id,a))
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
  // Owner console actions. The admin page carries a task id only; the task's own
  // view is used here, so the console never borrows another window's authority
  // and can act on exactly the rows the operations status already lists.
  act({id,action,message}) {
    if(!['cancel','takeover','steer'].includes(action))throw Error('操作无效')
    const row=this.db.prepare('SELECT id,view_id,state FROM yoyo_team_tasks WHERE id=?').get(id)
    if(!row)throw Error('任务不存在')
    const view=this.social.data.view(row.view_id)
    if(action==='cancel'){
      this.coordinator.cancel(row.id,row.view_id)
      return {id:row.id,action,cancelled:true,state:'cancelled'}
    }
    if(action==='takeover'){
      if(!view.focus)throw Error('这个任务没有可接管的窗口')
      const generation=this.tasks.takeover(row.view_id,this.social.sessionId,Date.now()+900000)
      return {id:row.id,action,generation}
    }
    const steered=this.tasks.steer(row.view_id,{taskId:row.id,message})
    return {id:row.id,action,...steered}
  }
  // The same code submitted twice for one task is one job, so a retried step does
  // not fan out duplicate work.
  executionKey(taskId,code) {
    return 'team-'+createHash('sha256').update(String(taskId)+':'+String(code??'')).digest('hex').slice(0,24)
  }
  // Reading a task's own material is a separate, deliberate act: it needs the
  // caller to confirm, it never aggregates several windows into one answer, and a
  // revoked or expired window stays unreadable even for the owner console.
  detail({id,confirm}) {
    if(confirm!==true)throw Error('需要确认查看该任务的资料范围')
    const row=this.db.prepare('SELECT * FROM yoyo_team_tasks WHERE id=?').get(id)
    if(!row)throw Error('任务不存在')
    // Live check: revocation invalidates the window immediately, not eventually.
    const view=this.social.data.view(row.view_id)
    const target=view.focus?this.social.data.target(view.focus,{approved:true}):null
    return {id:row.id,role:row.role,state:row.state,goal:row.goal,
      window:target?{label:target.label,platform:target.platform,kind:target.kind,peer:target.peer}:null,
      reports:this.db.prepare('SELECT id,body,created_at FROM yoyo_team_reports WHERE task_id=? ORDER BY id DESC LIMIT 20').all(row.id)
        .map(entry=>({id:entry.id,body:entry.body,createdAt:entry.created_at})),
      evidence:this.tasks.board(view.id,{taskId:row.id,limit:20}),
      memoryPack:this.tasks.memoryPack(row.id,view.id),
      usage:this.tasks.usage(row.id)}
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
  mainEnqueue(view,key,target=view.focus) {
    const lease=this.db.prepare('SELECT * FROM yoyo_team_speakers WHERE target=?').get(target)
    if(lease&&lease.expires_at>Date.now()&&lease.agent_id!==this.social.sessionId)throw Error('聊天执行者持有发言权，请先 team_takeover')
    const generation=lease&&lease.expires_at>Date.now()?lease.generation:this.tasks.takeover(view.id,this.social.sessionId,Date.now()+900000,target)
    this.tasks.authorizeSend(this.social.sessionId,target,generation)
    const remoteKey='yoyo-'+createHash('sha256').update(key).digest('hex').slice(0,24)
    this.db.prepare('INSERT OR IGNORE INTO yoyo_team_main_outbox VALUES(?,?,?)').run(remoteKey,target,generation)
  }
  mainDispatch(key) {
    const row=this.db.prepare('SELECT * FROM yoyo_team_main_outbox WHERE key=?').get(key)
    if(row)this.tasks.authorizeSend(this.social.sessionId,row.target,row.generation)
  }
  // Starting queued work is a host decision: a free slot, ready dependencies and
  // its own time. The subject's priority only orders the queue; it cannot bypass
  // the concurrency limit, so the subject is not silently forced to do the work.
  startIntent(intent,now=Date.now()){
    const role=this.intents.roleFor(intent)
    const task=this.tasks.create({key:'intent:'+intent.id+':'+intent.revision,role,goal:intent.goal,viewId:intent.view_id,expiresAt:now+(this.config.taskMs??900000),activityId:intent.activity_id??null})
    this.intents.claim(intent.id,{taskId:task.id,now})
    const started=this.coordinator.start(task.id)
    if(!started.started){this.intents.note(intent.id,'ready','插入任务后没有空位');return {started:false,reason:'capacity'}}
    return {...started,intentId:intent.id,role}
  }
  cancelIntent(id,reason,view=null){
    const intent=this.intents.get(id)
    if(!intent)throw Error('意图不存在')
    if(view)this.social.data.view(intent.view_id)
    if(intent.task_id){
      const row=this.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(intent.task_id)
      if(row&&!['completed','cancelled','blocked'].includes(row.state))this.coordinator.cancel(intent.task_id,intent.view_id)
    }
    return this.intents.cancel(id,reason)
  }
  activeWindow(target) {
    return !!this.db.prepare("SELECT 1 FROM yoyo_team_speakers s JOIN yoyo_team_tasks t ON t.id=s.task_id WHERE s.target=? AND s.expires_at>? AND t.state IN ('running','waiting')").get(target,Date.now())
  }
  // A window belongs to a branch while a chat/peer task runs or is suspended on
  // it. The subject is not woken for those messages; the host hands them over.
  ownsWindow(target) {
    if(!target)return false
    return !!this.db.prepare("SELECT 1 FROM yoyo_team_tasks WHERE focus_key=? AND role IN ('chat','peer') AND state IN ('running','waiting','suspended') AND expires_at>? LIMIT 1").get(target,Date.now())
  }
  // Follow-up messages in a window that already has a chat executor go straight to
  // that executor, with a brief carrying the real message ids. The subject is not
  // asked to approve each line, and nothing here invents a "keep going" prompt.
  routeChatMessages(now=Date.now()) {
    const routed=[]
    for(const candidate of this.tasks.chatWakeCandidates({now,quietMs:this.social.config?.quietMs??5000})){
      if(this.coordinator.running.size>=this.coordinator.maxConcurrent)break
      let started=null
      try{started=this.coordinator.start(candidate.id,{wake:{kind:'new_messages',after:candidate.after,through:candidate.through,count:candidate.count}})}catch{continue}
      if(!started.started)break
      // The cursor moves when the delivery is handed over, not when the branch
      // paused: a message that arrived during the run is never lost, at worst it
      // costs one extra wake.
      this.tasks.ackChatThrough(candidate.id,candidate.through)
      this.social.metrics?.count('chat_routed_to_executor')
      routed.push({taskId:candidate.id,target:candidate.target,count:candidate.count,through:candidate.through})
    }
    return routed
  }
  // Read-only operational view for the admin page: who runs what, how long they
  // have left, why a task is waiting, and what it has spent. No goal, no report
  // text and no private window content.
  status() {
    const tasks=this.db.prepare(`SELECT t.id,t.role,t.state,t.attempt,t.failures,t.retry_at,t.renewed_at,t.expires_at,t.paused_reason,t.wake_count,t.chat_through,
      coalesce((SELECT sum(u.steps) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) steps,
      coalesce((SELECT sum(u.tokens) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) tokens,
      coalesce((SELECT max(u.tokens_reported) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) tokensReported,
      (SELECT s.target FROM yoyo_team_speakers s WHERE s.task_id=t.id AND s.expires_at>?) leaseTarget,
      (SELECT s.expires_at FROM yoyo_team_speakers s WHERE s.task_id=t.id AND s.expires_at>?) leaseExpires,
      (SELECT count(*) FROM yoyo_team_reports r WHERE r.task_id=t.id) reports,
      (SELECT count(*) FROM yoyo_team_evidence e WHERE e.task_id=t.id) evidence
      FROM yoyo_team_tasks t ORDER BY t.created_at DESC LIMIT 50`).all(Date.now(),Date.now())
    return {concurrency:{running:this.coordinator.running.size,max:this.coordinator.maxConcurrent},intents:this.intents.summary(),tasks:tasks.map(row=>{
      const depends=this.db.prepare('SELECT depends_on FROM yoyo_team_tasks WHERE id=?').get(row.id).depends_on
      const task={...row,tokensReported:row.tokensReported===1,dependsOn:depends?JSON.parse(depends).length:0}
      return {...task,waitReason:this.waitReason(task),waitingFor:this.db.prepare("SELECT count(*) n FROM yoyo_team_events q WHERE q.kind='question' AND q.to_task=? AND NOT EXISTS(SELECT 1 FROM yoyo_team_events a WHERE a.kind='answer' AND a.ref=q.event_id)").get(row.id).n}
    }),timeline:this.timeline()}
  }
  // Timeline for the admin page: who sent what kind of event to whom, when it was
  // delivered, and whether it is still unanswered. Kinds, ids and timing only -
  // goals, reports and window content stay behind team_inspect.
  timeline({limit=30}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('事件条数无效')
    return this.db.prepare(`SELECT e.id,e.event_id,e.kind,e.from_task,e.to_task,e.activity_id,e.created_at,
      e.delivered_count,e.expires_at,
      (e.kind='question' AND NOT EXISTS(SELECT 1 FROM yoyo_team_events a WHERE a.kind='answer' AND a.ref=e.event_id)) open
      FROM yoyo_team_events e ORDER BY e.id DESC LIMIT ?`).all(limit)
      .map(row=>({eventId:row.event_id,kind:row.kind,from:row.from_task,to:row.to_task,activityId:row.activity_id,
        at:row.created_at,delivered:row.delivered_count,openQuestion:!!row.open,expiresAt:row.expires_at}))
  }
  // A small, content-free digest for the subject's dynamic state: enough to know
  // that branches are alive and that someone is waiting for an answer, without
  // pasting goals or report bodies into every turn. Details stay behind
  // team_inspect / team_events, which check the current view.
  digest(viewId) {
    try{
      const view=this.social.data.view(viewId)
      const tasks=this.db.prepare("SELECT id,role,state,expires_at,failures,retry_at FROM yoyo_team_tasks WHERE state IN ('ready','running','waiting','blocked','suspended') ORDER BY created_at DESC LIMIT 8").all()
        .map(row=>({id:row.id,role:row.role,state:row.state,waitReason:this.waitReason(row)}))
      const events=this.tasks.activityEvents(view.id,{limit:5}).map(({eventId,kind,from,to,at})=>({eventId,kind,from,to,at}))
      const queue=this.intents.summary({limit:20})
      return {running:this.coordinator.running.size,max:this.coordinator.maxConcurrent,tasks,openQuestions:this.tasks.openQuestions(view.id).length,recentEvents:events,
        queue:{ready:queue.filter(item=>item.state==='ready').length,running:queue.filter(item=>item.state==='running').length,
          blocked:queue.filter(item=>item.state==='blocked').length,next:queue.filter(item=>item.state==='ready').slice(0,3).map(item=>({id:item.id,capabilities:item.capabilities,waitedMs:item.waitedMs,waitReason:item.waitReason}))}}
    }catch{return null}
  }
  // When the subject changes what an activity is for, the branches working on it
  // hear about it at their next boundary instead of finishing the old goal.
  announceDirection(viewId,{activityId,goal,state,revision,previousGoal=null,previousState=null}) {
    if(!activityId)return null
    try{
      return this.tasks.publishEvent({fromTask:null,activityId,kind:'direction_changed',
        body:'主体把活动目标改为：'+goal+'（状态 '+state+'）',
        baseRevision:revision,dedupeKey:'direction:'+activityId+':'+revision,viewId})
    }catch{return null}
  }
  waitReason(row) {
    if(row.state==='blocked')return row.retry_at?'等待重试':row.failures?'失败，等待复查':'已阻塞'
    if(row.state==='ready')return row.dependsOn?'等待依赖任务':'等待调度'
    if(row.state==='running')return row.leaseExpires?'执行中':'执行中（无发言租约）'
    if(row.state==='waiting')return '等待对方回复'
    if(row.state==='suspended')return '等待该窗口的新消息'
    return row.state
  }
  tick() {
    const settings=this.social.store.get('yoyo_settings',{})
    if(settings.paused)return
    // A suspended activity whose window has new messages is woken here, by the
    // host, with the message ids; there is no fixed "continue" prompt and no
    // model-side polling. Expired suspensions end their activity instead.
    const now=Date.now()
    this.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE state='suspended' AND expires_at<=?").run(now)
    // Attempt state follows the task, then the queue is served by priority, aging,
    // dependencies and the real slot count.
    this.intents.syncFromTasks(now)
    this.routeChatMessages(now)
    for(const intent of this.intents.ready({now})){
      if(this.coordinator.running.size>=this.coordinator.maxConcurrent)break
      try{this.startIntent(intent,now)}
      catch(error){this.intents.note(intent.id,'blocked','无法启动：'+String(error?.message??'').slice(0,200))}
    }
    // Cold branches that no longer support anything active become a summary with
    // references. Their rows stay; only the subject's attention shrinks.
    for(const {view_id} of this.db.prepare('SELECT DISTINCT view_id FROM yoyo_team_tasks').all()){
      try{this.folding.fold(view_id,{now})}catch{/* revoked work stays unfolded */}
    }
    // Retries are opt-in. A task whose last send is uncertain is never retried.
    if(this.config.retryBlocked)for(const row of this.tasks.resumable({now:Date.now()})){
      try{this.tasks.inspect(row.id,row.view_id);this.tasks.requeue(row.id)}catch{/* Revoked work stays blocked. */}
    }
    for(const task of this.db.prepare("SELECT id,view_id,expires_at,depends_on FROM yoyo_team_tasks WHERE state='ready' ORDER BY created_at LIMIT 20").all()){
      if(this.coordinator.running.size>=this.coordinator.maxConcurrent)break
      // A dependent task waits for its dependencies instead of starting early.
      if(task.depends_on&&!JSON.parse(task.depends_on).every(id=>this.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(id)?.state==='completed'))continue
      try{
        const motivation=this.db.prepare('SELECT concern_id FROM yoyo_team_intents WHERE task_id=?').get(task.id)
        const queued=this.db.prepare('SELECT id,state,concern_id FROM yoyo_intents WHERE task_id=?').get(task.id)
        const concernId=queued?.concern_id??motivation?.concern_id
        const concern=this.social.data.concerns(task.view_id).find(c=>c.id===concernId)
        // Queued work answers to its intent; delegated work keeps answering to the
        // concern it was created for. Either way a dead or expired task never starts.
        const dead=queued?['abandoned','completed'].includes(queued.state):(!concern||concern.state!=='active')
        const concernLost=queued?.concern_id&&(!concern||concern.state!=='active')
        if(dead||concernLost||task.expires_at<=Date.now()){
          this.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE id=?").run(task.id)
          if(queued)this.intents.note(queued.id,'abandoned','任务启动前已失效')
          continue
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
