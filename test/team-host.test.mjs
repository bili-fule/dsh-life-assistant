import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { MemoryLayer } from '../src/memory-layer.mjs'
import { OrchestrationMetrics } from '../src/orchestration-metrics.mjs'

function fixture(t,config={}){
  const root=mkdtempSync(join(tmpdir(),'team-host-')),store=new Store(join(root,'test.sqlite')),data=new SocialStore(store)
  const social={store,data,separate:true,sessionId:'main',qq:null,metrics:new OrchestrationMetrics(store.db)},host=new TeamHost(social,config)
  const target=data.discover({platform:'qq',account:'1',kind:'private',peer:'2'})
  data.approve(target.handle,true)
  const view=data.open(target.handle),task=host.tasks.create({key:'test',role:'chat',goal:'chat',viewId:view.id,expiresAt:Date.now()+60000})
  const context={args:{text:'hello',replyId:'input-1'},view,agentId:'worker',taskId:task.id,signal:new AbortController().signal,authorize:()=>host.tasks.authorizeSend('worker',view.focus,1)}
  store.set('yoyo_settings',{observeOnly:false,dailySteps:100})
  t.after(async()=>{await host.stop();store.close();rmSync(root,{recursive:true,force:true})})
  // Another platform in the same database is a genuinely independent subject:
  // a view opened from it carries only ['public', its own scope].
  const wechat=(peer='alice')=>{const t=data.discover({platform:'wechat',account:'bound',kind:'owner',peer});return data.approve(t.handle,true)}
  return {store,data,social,host,view,task,context,wechat}
}
test('worker delivery persists a real receipt and duplicate logical replies do not resend',async t=>{
  const {host,social,task,context,data}=fixture(t);let sent=0
  social.qq={async send(target,text,key,signal,authorize){authorize();sent++;return {messageId:'actual-1'}}}
  host.tasks.claim(task.id,'worker')
  assert.equal((await host.send(context)).state,'sent')
  assert.equal((await host.send(context)).replayed,true)
  assert.equal(sent,1)
  assert.equal(data.db.prepare("SELECT count(*) n FROM yoyo_events WHERE kind='outgoing'").get().n,1)
  await assert.rejects(host.send({...context,args:{text:'different',replyId:'input-1'}}),/其他内容/)
})
test('uncertain network outcome is never blindly retried and paused tasks cannot send',async t=>{
  const {host,social,store,task,context}=fixture(t);let sent=0
  social.qq={async send(){sent++;throw Error('network interrupted')}}
  host.tasks.claim(task.id,'worker')
  await assert.rejects(host.send(context))
  assert.equal((await host.send(context)).state,'uncertain')
  assert.equal(sent,1)
  store.set('yoyo_settings',{paused:true,observeOnly:false})
  await assert.rejects(host.send({...context,args:{text:'new',replyId:'input-2'}}),/暂停/)
  assert.equal(sent,1)
})
test('missing platform receipt is uncertain, not fabricated success',async t=>{
  const {host,social,task,context}=fixture(t)
  social.qq={async send(){return {messageId:null}}}
  host.tasks.claim(task.id,'worker')
  await assert.rejects(host.send(context),/回执/)
  assert.equal((await host.send(context)).state,'uncertain')
})
test('main queued message is fenced by delegation and completion emits one scoped event',t=>{
  const {host,view,task}=fixture(t)
  host.mainEnqueue(view,'original-call')
  const row=host.db.prepare('SELECT key FROM yoyo_team_main_outbox').get()
  host.mainDispatch(row.key)
  host.db.prepare('UPDATE yoyo_team_speakers SET expires_at=0').run()
  host.tasks.claim(task.id,'worker')
  assert.throws(()=>host.mainDispatch(row.key),/失效/)
  assert.throws(()=>host.mainEnqueue(view,'new-call'),/发言权/)
  host.tasks.finish('worker')
  const event=host.nextEvent()
  assert.equal(event.id,task.id);assert.equal(event.view.id,view.id)
  host.acknowledge(task.id)
  assert.equal(host.nextEvent(),null)
})
test('restart blocks active execution and preserves uncertainty without resubmitting',t=>{
  const {host,social,task}=fixture(t)
  host.tasks.claim(task.id,'worker')
  host.db.prepare("INSERT INTO yoyo_team_deliveries VALUES(?,?,?,'sending',NULL)").run('key',task.id,'test')
  const recovered=new TeamHost(social,{})
  assert.equal(recovered.tasks.overview()[0].state,'blocked')
  assert.equal(host.db.prepare('SELECT state FROM yoyo_team_deliveries').get().state,'uncertain')
  assert.throws(()=>host.tasks.authority('worker'))
})
test('the operational status exposes executors, leases and usage without task content',t=>{
  const {host,view,task}=fixture(t)
  host.tasks.claim(task.id,'worker')
  host.tasks.recordStep('worker',5)
  host.tasks.recordTokens('worker',42)
  host.tasks.report('worker','PRIVATE_GOAL_DETAIL')
  host.tasks.evidence('worker',{body:'PRIVATE_EVIDENCE'})
  const status=host.status()
  assert.equal(status.concurrency.max,2)
  assert.equal(status.tasks.length,1)
  const row=status.tasks[0]
  assert.equal(row.id,task.id)
  assert.equal(row.state,'running')
  assert.equal(row.steps,1)
  assert.equal(row.tokens,42)
  assert.equal(row.reports,1)
  assert.equal(row.evidence,1)
  assert.ok(row.leaseTarget,'the lease holder is visible')
  assert.match(row.waitReason,/执行中/)
  assert.equal(JSON.stringify(status).includes('PRIVATE'),false,'no goal or report text leaves the host')
  assert.equal(JSON.stringify(status).includes('secret goal'),false)
  // A blocked task explains itself instead of just saying blocked.
  host.tasks.noteFailure(task.id,{maxAttempts:2,backoffMs:60000})
  const blocked=host.status().tasks[0]
  assert.equal(blocked.state,'blocked')
  assert.match(blocked.waitReason,/重试|复查/)
  // The admin panel reads exactly these fields; keep the contract explicit.
  for(const field of ['id','role','state','attempt','failures','retry_at','steps','tokens','tokensReported','reports','evidence','leaseExpires','dependsOn','waitReason'])
    assert.equal(field in blocked,true,'status row carries '+field)
  assert.equal(typeof blocked.tokensReported,'boolean')
  assert.equal(blocked.tokensReported,true,'a real token report is visible as reported')
  assert.equal(host.tasks.usage(task.id).note,null)
  // A run whose runtime never reported usage is not shown as a free run.
  const silent=host.tasks.create({key:'silent',role:'reader',goal:'g',viewId:view.id,expiresAt:Date.now()+60000})
  host.tasks.claim(silent.id,'worker-2')
  host.tasks.recordStep('worker-2',5)
  const silentStatus=host.status().tasks.find(row=>row.id===silent.id)
  assert.equal(silentStatus.tokens,0)
  assert.equal(silentStatus.tokensReported,false)
  assert.match(host.tasks.usage(silent.id).note,/未测量/)
})
test('the owner console can cancel, take over or steer without borrowing another scope',t=>{
  const {host,view,task,data}=fixture(t)
  host.tasks.claim(task.id,'worker')
  // A steering note is queued for the running worker and delivered once.
  assert.equal(host.act({id:task.id,action:'steer',message:'顺带看一下评论区'}).delivered,false)
  assert.deepEqual(host.tasks.takeSteers('worker'),['顺带看一下评论区'])
  // Takeover moves the window's speaking right to the main session.
  assert.equal(host.act({id:task.id,action:'takeover'}).generation,2)
  assert.throws(()=>host.tasks.authorizeSend('worker',view.focus,1),/失效/)
  // Cancel fences later sends and steering.
  assert.equal(host.act({id:task.id,action:'cancel'}).state,'cancelled')
  assert.throws(()=>host.act({id:task.id,action:'steer',message:'太晚了'}),/进行中/)
  assert.throws(()=>host.act({id:task.id,action:'delete'}),/操作无效/)
  assert.throws(()=>host.act({id:'no-such-task',action:'cancel'}),/不存在/)
  // The console resolves the task's own view, never the caller's ambient one.
  const other=data.discover({platform:'qq',account:'1',kind:'private',peer:'7'})
  data.approve(other.handle,true)
  const foreign=data.open(other.handle)
  const second=host.tasks.create({key:'second',role:'chat',goal:'g',viewId:foreign.id,expiresAt:Date.now()+60000})
  assert.equal(host.act({id:second.id,action:'cancel'}).cancelled,true)
  assert.equal(host.tasks.inspect(second.id,foreign.id).state,'cancelled')
})
test('task material is readable one task at a time, only with confirmation and a live window',t=>{
  const {host,view,task,data}=fixture(t)
  host.tasks.claim(task.id,'worker')
  host.tasks.report('worker','检查了评论区的两条说法')
  host.tasks.evidence('worker',{kind:'source',source:'https://example.com/a',body:'文章说长镜头在结尾'})
  assert.throws(()=>host.detail({id:task.id}),/确认/)
  assert.throws(()=>host.detail({id:task.id,confirm:false}),/确认/)
  const detail=host.detail({id:task.id,confirm:true})
  assert.equal(detail.goal,'chat')
  assert.equal(detail.reports.length,1)
  assert.match(detail.reports[0].body,/评论区/)
  assert.equal(detail.evidence.length,1)
  assert.equal(detail.window.kind,'private')
  assert.equal(detail.window.peer,'2')
  assert.equal(detail.usage.steps>=0,true)
  // Revocation closes the window immediately: the same request now fails.
  data.approve(view.focus,false)
  assert.throws(()=>host.detail({id:task.id,confirm:true}),/授权|范围/)
  assert.throws(()=>host.detail({id:'no-such-task',confirm:true}),/不存在/)
})
test('an engineering worker runs code in the isolated runner and reads only its own jobs',async t=>{
  const {host,social,view,task,data}=fixture(t),started=[]
  social.executor={
    async start(args,runView,key){started.push({key,scopes:runView.scopes,language:args.language});return {id:'a'.repeat(64),state:'running'}},
    async call(path,body){return {state:'done',exitCode:0,stdout:'1+1=2',id:body.id}}
  }
  const publicView=data.publicView()
  const engineered=host.tasks.create({key:'eng',role:'engineer',goal:'算一下',viewId:publicView.id,expiresAt:Date.now()+60000})
  host.tasks.claim(engineered.id,'worker-eng')
  const tools=host.coordinator.tools
  const started1=await tools.execute({args:{code:'console.log(1+1)',language:'node'},view:publicView,taskId:engineered.id,signal:undefined})
  assert.equal(started1.id,'a'.repeat(64))
  assert.equal(started[0].language,'node')
  assert.deepEqual(started[0].scopes,['public'],'only public material reaches the runner')
  // The same code twice for one task is one job, not two.
  const again=await tools.execute({args:{code:'console.log(1+1)',language:'node'},view:publicView,taskId:engineered.id,signal:undefined})
  assert.equal(started[1].key,started[0].key)
  assert.equal(again.id,started1.id)
  const status=await tools.job({args:{id:started1.id},view:publicView,signal:undefined})
  assert.equal(status.exitCode,0)
  // A public job is readable anywhere, a private one is not: scope still rules.
  assert.equal((await tools.job({args:{id:started1.id},view:task.view_id?data.publicView():publicView})).exitCode,0)
  data.db.prepare("INSERT INTO yoyo_jobs(id,run_key,scopes,created_at,view_id,state) VALUES(?,?,?,?,?,?)")
    .run('c'.repeat(64),'private-key',JSON.stringify(view.scopes),Date.now(),view.id,'done')
  await assert.rejects(()=>tools.job({args:{id:'c'.repeat(64)},view:publicView}),/范围/)
  data.db.prepare("INSERT INTO yoyo_jobs(id,run_key,scopes,created_at,view_id,state,backend) VALUES(?,?,?,?,?,?,?)")
    .run('b'.repeat(64),'debug-key','["public"]',Date.now(),publicView.id,'done','debug')
  await assert.rejects(()=>tools.job({args:{id:'b'.repeat(64)},view:publicView}),/排障/)
  // Without an isolated runner the worker is told so instead of silently failing.
  social.executor=null
  await assert.rejects(()=>tools.execute({args:{code:'x',language:'node'},view:publicView,taskId:engineered.id}),/隔离执行服务/)
})
test('a peer executor calls the subject’s own tools with the task view, and nothing more',async t=>{
  const {host,social,view,task,data}=fixture(t),calls=[]
  social.peerTools=new Map([
    ['yoyo_read',async(args,exec,key,runView)=>{calls.push({name:'yoyo_read',args,key,scopes:runView.scopes});return {messages:[{id:1,text:'预览'}],receipt:key}}],
    ['memory_recall',async(args,exec,key,runView)=>{calls.push({name:'memory_recall',args,key,scopes:runView.scopes});return {results:[],receipt:key}}]
  ])
  const peer=host.tasks.create({key:'peer',role:'peer',goal:'一起聊',viewId:view.id,expiresAt:Date.now()+60000})
  host.tasks.claim(peer.id,'worker-peer')
  const tools=host.coordinator.tools
  const read=await tools.read({args:{limit:5},view,agentId:'worker-peer',signal:undefined})
  assert.equal(read.messages[0].text,'预览')
  assert.equal(calls[0].scopes.includes('public'),true,'执行者用的是任务自己的视图')
  assert.match(calls[0].key,/^team-[a-f0-9]{24}$/,'调用带任务级回执编号')
  // The same call twice is the same receipt, so evidence stays traceable.
  await tools.read({args:{limit:5},view,agentId:'worker-peer',signal:undefined})
  assert.equal(calls[1].key,calls[0].key)
  await tools.memory_recall({args:{query:'语音'},view,agentId:'worker-peer',signal:undefined})
  assert.equal(calls[2].name,'memory_recall')
  // Tools the subject keeps private are not wired to the bridge at all.
  for(const reserved of ['memory_retract','yoyo_open','yoyo_mute','yoyo_attention','team_delegate','yoyo_debug'])
    assert.equal(reserved in tools,false,'不向执行者暴露 '+reserved)
  // A peer tool the subject did not expose stays unavailable rather than half-working.
  await assert.rejects(()=>tools.search({args:{query:'x'},view,agentId:'worker-peer'}),/对执行者未启用/)
  // Cancelling the task removes the authority behind the bridge.
  host.act({id:peer.id,action:'cancel'})
  await assert.rejects(()=>tools.read({args:{},view,agentId:'worker-peer'}),/失效/)
  assert.equal(task.id.length>0,true)
  assert.ok(data)
})
test('operational status reports the queue, the meters and the folded count without any goal text',async t=>{
  const {host,view}=fixture(t)
  host.intents.create({goal:'SECRET-GOAL-TEXT',why:'内部理由',capabilities:['read'],priority:10,viewId:view.id})
  const status=host.status()
  assert.equal(Array.isArray(status.intents),true)
  assert.equal(status.intents.length,1)
  assert.equal(JSON.stringify(status.intents).includes('SECRET-GOAL-TEXT'),false,'the operational view names states, not goals')
  assert.equal(JSON.stringify(status.intents).includes('内部理由'),false)
  assert.ok(status.metrics,'the panel can show real counters and latencies')
  assert.equal(typeof status.folded.count,'number')
})

test('the admin page renders the team panel from the operational status only',t=>{
  const page=readFileSync(new URL('../public/index.html',import.meta.url),'utf8')
  const script=readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
  assert.match(page,/id="yoyo-team"/,'the page has a slot for the team panel')
  assert.match(script,/function renderTeam\(team\)/)
  assert.match(script,/renderTeam\(y\.team\)/,'the panel is fed from the operational status')
  // The panel states the privacy boundary instead of quietly showing everything.
  assert.match(page,/任务目的与报告正文留在各自的资料范围/)
  assert.match(script,/任务目的与报告正文默认不展示/)
  assert.match(script,/Token 未上报/,'an unreported token count is not rendered as zero')
  // The panel offers the three owner actions through one admin endpoint.
  for(const action of ['steer','takeover','cancel'])assert.match(script,new RegExp("action:'"+action+"'"))
  assert.match(script,/\/api\/yoyo\/team/)
  // Task material is read one task at a time, after an explicit confirmation.
  assert.match(script,/function showTaskDetail\(task,card\)/)
  assert.match(script,/\/api\/yoyo\/team-detail/)
  // The queue, the meters and the folded branches come from the same status, and
  // they are rendered as states and counts rather than as goals.
  assert.match(script,/意图队列（等待调度/)
  assert.match(script,/计量（宿主自己观测）/)
  assert.match(script,/已折叠 /)
  assert.match(script,/window\.confirm\('这会显示该任务的目的、报告与证据/)
  assert.equal(/goal|PRIVATE|报告正文.*innerHTML/.test(script.split('function renderTeam')[1].split('function renderYoyo')[0].replace(/任务目的与报告正文默认不展示/,'')),false,'the panel never renders task text on its own')
})
test('cancellation stops steering and another subject cannot steer or read the board',t=>{
  const {host,view,task,data,wechat}=fixture(t),foreign=data.open(wechat('9').handle)
  host.tasks.claim(task.id,'worker')
  host.tasks.evidence('worker',{kind:'finding',body:'同主体的另一个窗口也读得到'})
  assert.throws(()=>host.tasks.steer(foreign.id,{taskId:task.id,message:'越范围'}),/范围/)
  assert.throws(()=>host.tasks.board(foreign.id,{taskId:task.id}),/范围/)
  // The same subject's other window keeps its reading rights; the task is still fenced.
  const sameOwner=data.discover({platform:'qq',account:'1',kind:'private',peer:'8'})
  data.approve(sameOwner.handle,true)
  assert.equal(host.tasks.board(data.open(sameOwner.handle).id,{taskId:task.id}).length,1)
  host.coordinator.cancel(task.id,view.id)
  assert.throws(()=>host.tasks.steer(view.id,{taskId:task.id,message:'已经取消'}),/进行中/)
})
test('worker steps are metered in the database and survive a new host',async t=>{
  const {host,social,task}=fixture(t)
  host.tasks.claim(task.id,'worker')
  const first=await host.coordinator.tools.step({agentId:'worker'})
  assert.equal(first.allowed,true);assert.equal(first.step,1)
  assert.equal((await host.coordinator.tools.step({agentId:'worker'})).step,2)
  await host.coordinator.tools.usage({agentId:'worker',tokens:900})
  assert.deepEqual(host.tasks.usage(task.id),{steps:2,tokens:900,tokensReported:true,attempts:1,note:null})
  // A fresh store over the same database still sees the same counters.
  const reopened=new TeamStore(social.data)
  assert.deepEqual(reopened.usage(task.id),{steps:2,tokens:900,tokensReported:true,attempts:1,note:null})
  assert.equal(reopened.overview().find(row=>row.id===task.id).tokens,900)
  // A paused subject cannot spend more budget.
  social.store.set('yoyo_settings',{paused:true,observeOnly:false})
  await assert.rejects(()=>host.coordinator.tools.step({agentId:'worker'}),/暂停|预算/)
})
test('a failed task is retried only when enabled, bounded, and never after an uncertain send',t=>{
  const {host,view,data}=fixture(t,{retryBlocked:true,retryAttempts:2,retryDelayMs:0})
  const concern=data.concern(view.id,{title:'t',why:'w',origin:'o',next:'n',doneWhen:'d',stopWhen:'s'})
  const args={concernId:concern.id,rationale:'继续聊',role:'chat',goal:'聊天',viewId:view.id,expiresAt:Date.now()+60000}
  const task=host.motivation.delegate({...args,key:'retry-1'})
  host.tasks.claim(task.id,'worker')
  host.tasks.noteFailure(task.id,{maxAttempts:2,backoffMs:0})
  assert.equal(host.tasks.inspect(task.id,view.id).state,'blocked')
  const started=[];host.coordinator.start=id=>{started.push(id);return {started:true,id}}
  host.tick()
  assert.deepEqual(started,[task.id])
  // A task whose last reply is uncertain must never be replayed automatically.
  host.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE id=?").run(task.id)
  host.db.prepare('UPDATE yoyo_team_speakers SET expires_at=0').run()
  const second=host.motivation.delegate({...args,key:'retry-2'})
  host.tasks.claim(second.id,'worker2')
  host.db.prepare("INSERT INTO yoyo_team_deliveries VALUES(?,?,?,'uncertain',NULL)").run('retry-key',second.id,'text')
  host.tasks.noteFailure(second.id,{maxAttempts:2,backoffMs:0})
  started.length=0;host.tick()
  assert.deepEqual(started,[])
  // Without the switch nothing is resumed at all.
  host.config.retryBlocked=false
  host.db.prepare("UPDATE yoyo_team_deliveries SET state='sent' WHERE task_id=?").run(second.id)
  host.tasks.noteFailure(second.id,{maxAttempts:3,backoffMs:0})
  started.length=0;host.tick()
  assert.deepEqual(started,[])
})
test('the cross-task evidence search tool answers inside the window only',async t=>{
  const {host,view,task}=fixture(t),tools={}
  host.register((name,description,properties,required,execute)=>{tools[name]={description,properties,required,execute}})
  assert.ok(tools.team_search,'the host exposes the search tool')
  host.tasks.claim(task.id,'worker')
  host.tasks.evidence('worker',{kind:'source',source:'https://example.com/a',body:'公开材料里提到长镜头'})
  const found=await tools.team_search.execute({query:'长镜头'},{},null,view)
  assert.equal(found.results.length,1)
  assert.equal(found.results[0].taskId,task.id)
  assert.match(found.results[0].body,/长镜头/)
  // Nothing is returned for a clue that no evidence mentions.
  assert.deepEqual((await tools.team_search.execute({query:'不存在的词'},{},null,view)).results,[])
})
test('an accepted memory candidate becomes a worker report, never an observation',async t=>{
  const {host,view,task,data}=fixture(t),tools={}
  host.memory=new MemoryLayer(data)
  host.register((name,description,properties,required,execute)=>{tools[name]={description,execute}})
  const message=data.ingest({target:view.focus,sender:'2',externalId:'m1',text:'我平时更喜欢发语音'}).id
  host.tasks.claim(task.id,'worker')
  host.tasks.memoryCandidate('worker',{kind:'claim',claimType:'preference',statement:'对方更习惯发语音',
    context:'聊到沟通方式',evidence:{messages:[message]}})
  const listed=await tools.team_memory.execute({},{},null,view)
  assert.equal(listed.candidates.length,1)
  assert.equal(listed.candidates[0].taskId,task.id)
  const accepted=await tools.team_memory.execute({id:listed.candidates[0].id,decision:'accept'},{},null,view)
  assert.equal(accepted.state,'accepted')
  const stored=data.db.prepare('SELECT confidence,kind FROM yoyo_memory_claims WHERE id=?').get(accepted.memory.id)
  assert.equal(stored.confidence,'worker_report','a hand-over never becomes an observation')
  assert.equal(stored.kind,'preference')
  // A rejected candidate leaves no episode behind and keeps the stated reason.
  host.tasks.memoryCandidate('worker',{kind:'episode',statement:'聊过一次语音习惯',context:'他在地铁上不方便听语音',evidence:{messages:[message]}})
  const pending=(await tools.team_memory.execute({},{},null,view)).candidates[0]
  const rejected=await tools.team_memory.execute({id:pending.id,decision:'reject',reason:'同一条原文已经用过'},{},null,view)
  assert.equal(rejected.state,'rejected')
  assert.equal(data.db.prepare('SELECT count(*) n FROM yoyo_memory_episodes').get().n,0)
})
test('a delegated task starts with a scoped pack of memory summaries',async t=>{
  const {host,view,data,wechat}=fixture(t),tools={}
  host.memory=new MemoryLayer(data)
  host.register((name,description,properties,required,execute)=>{tools[name]={properties,execute}})
  host.coordinator.start=id=>({started:true,id})
  const message=data.ingest({target:view.focus,sender:'2',externalId:'p1',text:'我们上次聊到纪录片里的长镜头'}).id
  host.memory.propose(view.id,{kind:'episode',title:'聊过纪录片',role:'participant',what:'聊了纪录片里的长镜头',evidence:{messages:[message]}})
  const concern=data.concern(view.id,{title:'t',why:'w',origin:'o',next:'n',doneWhen:'d',stopWhen:'s'})
  const delegated=await tools.team_delegate.execute({concernId:concern.id,role:'reader',goal:'读一下相关材料',rationale:'想继续了解',recall:'纪录片 长镜头'},{},'pack-key',view)
  assert.equal(delegated.memoryPack.items,1)
  const pack=host.tasks.memoryPack(delegated.id,view.id)
  assert.equal(pack.clue,'纪录片 长镜头')
  assert.equal(pack.items[0].kind,'episode')
  // The worker gets the summaries through the bridge, and only its own task's pack.
  host.tasks.claim(delegated.id,'worker')
  assert.equal((await host.coordinator.tools.pack({agentId:'worker',view})).pack.items.length,1)
  // Without a clue there is no pack, and a pack stays out of another subject.
  const plain=await tools.team_delegate.execute({concernId:concern.id,role:'reader',goal:'再读一遍',rationale:'复核'},{},'pack-key-2',view)
  assert.equal(plain.memoryPack,undefined)
  assert.equal(host.tasks.memoryPack(plain.id,view.id),null)
  assert.throws(()=>host.tasks.memoryPack(delegated.id,data.open(wechat('3').handle).id),/范围/)
})
