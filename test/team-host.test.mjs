import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { TeamStore } from '../src/team-store.mjs'

function fixture(t,config={}){
  const root=mkdtempSync(join(tmpdir(),'team-host-')),store=new Store(join(root,'test.sqlite')),data=new SocialStore(store)
  const social={store,data,separate:true,sessionId:'main',qq:null},host=new TeamHost(social,config)
  const target=data.discover({platform:'qq',account:'1',kind:'private',peer:'2'})
  data.approve(target.handle,true)
  const view=data.open(target.handle),task=host.tasks.create({key:'test',role:'chat',goal:'chat',viewId:view.id,expiresAt:Date.now()+60000})
  const context={args:{text:'hello',replyId:'input-1'},view,agentId:'worker',taskId:task.id,signal:new AbortController().signal,authorize:()=>host.tasks.authorizeSend('worker',view.focus,1)}
  store.set('yoyo_settings',{observeOnly:false,dailySteps:100})
  t.after(async()=>{await host.stop();store.close();rmSync(root,{recursive:true,force:true})})
  return {store,data,social,host,view,task,context}
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
  assert.ok(view)
})
test('cancellation stops steering and a foreign window cannot steer or read the board',t=>{
  const {host,view,task,data}=fixture(t),other=data.discover({platform:'qq',account:'1',kind:'private',peer:'9'})
  data.approve(other.handle,true)
  const foreign=data.open(other.handle)
  host.tasks.claim(task.id,'worker')
  assert.throws(()=>host.tasks.steer(foreign.id,{taskId:task.id,message:'越范围'}),/范围/)
  assert.throws(()=>host.tasks.board(foreign.id,{taskId:task.id}),/范围/)
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
  assert.deepEqual(host.tasks.usage(task.id),{steps:2,tokens:900,attempts:1})
  // A fresh store over the same database still sees the same counters.
  const reopened=new TeamStore(social.data)
  assert.deepEqual(reopened.usage(task.id),{steps:2,tokens:900,attempts:1})
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
