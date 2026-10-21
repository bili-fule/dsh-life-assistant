import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { TeamCoordinator } from '../src/team-coordinator.mjs'

// Branches of one subject talk through durable events with per-branch cursors.
// The database is the authority; the process notification is only a shortcut, so
// a restart resumes from the last acknowledged position instead of replaying.
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'team-events-')),store=new Store(join(root,'test.sqlite')),data=new SocialStore(store)
  const social={store,data,separate:true,sessionId:'main',qq:null}
  const tasks=new TeamStore(data),group=data.discover({platform:'qq',account:'1',kind:'group',peer:'x'})
  data.approve(group.handle,true),data.approve(data.discover({platform:'qq',account:'1',kind:'private',peer:'y'}).handle,true)
  const view=data.open(group.handle)
  const activity=data.startActivity(view.id,{goal:'看看 xmfu 群最近在聊什么',why:'私聊里答应了',step:'读群'})
  // Two read-only branches can work in the same window at once: they share the
  // subject's reading rights and take no speaking lease.
  const create=(key,role='reader')=>tasks.create({key,role,goal:key,viewId:view.id,expiresAt:Date.now()+600000,activityId:activity.activityId})
  const wechat=(peer='alice')=>{const row=data.discover({platform:'wechat',account:'bound',kind:'owner',peer});return data.open(data.approve(row.handle,true).handle)}
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
  return {store,data,social,tasks,view,activity,create,wechat}
}

test('a finding reaches a sibling branch while the author is still running',t=>{
  const {tasks,view,create}=fixture(t)
  const reader=create('读群'),researcher=create('查资料')
  tasks.claim(reader.id,'worker-reader');tasks.claim(researcher.id,'worker-research')
  // The reader publishes what it actually saw; the researcher is still working.
  tasks.evidence('worker-reader',{kind:'finding',body:'星洛提到一个新游戏双人模式',source:'群消息 12'})
  assert.equal(tasks.db.prepare("SELECT state FROM yoyo_team_tasks WHERE id=?").get(reader.id).state,'running')
  const received=tasks.drainEvents(researcher.id)
  assert.equal(received.length,1)
  assert.equal(received[0].kind,'finding')
  assert.equal(received[0].from,reader.id)
  assert.match(received[0].body,/双人模式/)
  // Delivery is a cursor move: the same event is never handed over twice.
  assert.deepEqual(tasks.drainEvents(researcher.id),[])
  assert.equal(tasks.db.prepare('SELECT delivered_count FROM yoyo_team_events WHERE kind=?').get('finding').delivered_count,1)
  // The author does not receive its own finding back.
  assert.deepEqual(tasks.drainEvents(reader.id),[])
  assert.ok(view.focus)
})

test('branches ask and answer each other directly, with the correlation kept',t=>{
  const {tasks,view,create,wechat}=fixture(t)
  const reader=create('读群'),researcher=create('查资料')
  tasks.claim(reader.id,'worker-reader');tasks.claim(researcher.id,'worker-research')
  const asked=tasks.ask(reader.id,{toTask:researcher.id,question:'那个游戏叫什么名字？',viewId:view.id})
  assert.equal(asked.duplicate,undefined)
  const inbox=tasks.drainEvents(researcher.id)
  assert.equal(inbox[0].kind,'question')
  assert.equal(inbox[0].to,researcher.id)
  assert.equal(inbox[0].eventId,asked.eventId)
  // The answer comes back to the asker without the subject relaying anything.
  tasks.answer(researcher.id,{questionEventId:asked.eventId,answer:'叫「双人地牢」',viewId:view.id})
  const reply=tasks.drainEvents(reader.id)
  assert.equal(reply[0].kind,'answer')
  assert.equal(reply[0].ref,asked.eventId)
  assert.equal(reply[0].from,researcher.id)
  assert.deepEqual(tasks.openQuestions(view.id),[])
  // Another subject never sees any of it.
  const foreign=wechat()
  assert.deepEqual(tasks.activityEvents(foreign.id),[])
  assert.deepEqual(tasks.openQuestions(foreign.id),[])
})

test('an event is written once per dedupe key and expires instead of arriving late',t=>{
  const {tasks,view,create}=fixture(t)
  const reader=create('读群'),researcher=create('查资料')
  tasks.claim(reader.id,'worker-reader');tasks.claim(researcher.id,'worker-research')
  const first=tasks.publishEvent({fromTask:reader.id,activityId:tasks.inspect(reader.id,view.id).activity_id,kind:'progress',body:'读完一半',viewId:view.id,dedupeKey:'progress-1'})
  assert.ok(first.eventId)
  assert.equal(tasks.publishEvent({fromTask:reader.id,activityId:tasks.inspect(reader.id,view.id).activity_id,kind:'progress',body:'读完一半',viewId:view.id,dedupeKey:'progress-1'}).duplicate,true)
  assert.equal(tasks.db.prepare("SELECT count(*) n FROM yoyo_team_events WHERE dedupe_key='progress-1'").get().n,1)
  // A question with a deadline disappears instead of arriving after it matters.
  const now=Date.now()
  // Drain what is already there, so the next read only shows the late question.
  assert.equal(tasks.drainEvents(researcher.id).length,1)
  tasks.publishEvent({fromTask:reader.id,toTask:researcher.id,kind:'question',body:'还在吗',viewId:view.id,dedupeKey:'q-late',expiresAt:now+10})
  assert.deepEqual(tasks.drainEvents(researcher.id,{now:now+5000}),[])
  assert.throws(()=>tasks.publishEvent({fromTask:reader.id,toTask:researcher.id,kind:'question',body:'x',viewId:view.id,expiresAt:now-1}),/期限/)
  assert.throws(()=>tasks.publishEvent({fromTask:reader.id,toTask:researcher.id,kind:'shout',body:'x',viewId:view.id}),/事件类型/)
})

test('finishing and cancelling a branch are events its siblings can see',t=>{
  const {tasks,view,create,social}=fixture(t)
  const reader=create('读群'),researcher=create('查资料')
  tasks.claim(reader.id,'worker-reader');tasks.claim(researcher.id,'worker-research')
  tasks.finish('worker-reader')
  const seen=tasks.drainEvents(researcher.id)
  assert.equal(seen[0].kind,'completed')
  // Cancelling through the coordinator fences first and still tells the siblings.
  const coordinator=new TeamCoordinator({tasks,adapter:{run:async()=>({})},tools:{},maxConcurrent:2})
  const third=create('第三个分支')
  tasks.claim(third.id,'worker-third')
  tasks.db.prepare("UPDATE yoyo_team_tasks SET state='running' WHERE id=?").run(third.id)
  coordinator.cancel(third.id,view.id)
  const after=tasks.drainEvents(researcher.id)
  assert.equal(after[0].kind,'cancel')
  assert.equal(social.separate,true)
})

test('two branches really overlap and the find is shared before either ends',async t=>{
  const {tasks,view,create,social}=fixture(t)
  const reader=create('读群'),researcher=create('查资料')
  const agentOf=id=>'worker-'+createHash('sha256').update(id).digest('hex').slice(0,20)
  const readerAgent=agentOf(reader.id),researchAgent=agentOf(researcher.id)
  const log=[],gate={open:false,waiters:[]}
  const openGate=()=>{gate.open=true;for(const w of gate.waiters.splice(0))w()}
  const waitGate=()=>gate.open?Promise.resolve():new Promise(resolve=>gate.waiters.push(resolve))
  const adapter={async run({agentId,invoke}){
    log.push(['run',agentId===readerAgent?'reader':'research'])
    try{
    if(agentId===readerAgent){
      log.push(['reader-sees-group',Date.now()])
      await invoke('evidence',{kind:'finding',body:'群里说新玩法今晚开',source:'群消息 3'})
      await waitGate()
      await invoke('report',{body:'读完群，等研究结论'})
      log.push(['reader-ends',Date.now()])
      return {ok:true}
    }
    // The research branch keeps working while the group is being read, and picks
    // sibling events up at whichever native boundary comes next.
    let second=null
    for(let attempt=0;attempt<6&&!second;attempt++){
      const boundary=await invoke('step')
      if(boundary.events.some(event=>event.kind==='finding')){second=boundary;break}
      await waitGate()
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    assert.ok(second,'the finding arrives at a native boundary')
    const completedYet=!!tasks.db.prepare("SELECT 1 FROM yoyo_team_events WHERE kind='completed' AND from_task=?").get(reader.id)
    log.push(['research-received',Date.now(),completedYet])
    await invoke('report',{body:'据此改了搜索方向'})
    log.push(['research-ends',Date.now()])
    return {ok:true}
    }catch(error){log.push(['error',String(error.message)]);throw error}
  }}
  const tools={step:async()=>({ok:true})}
  const coordinator=new TeamCoordinator({tasks,adapter,tools,maxConcurrent:2})
  const startedA=coordinator.start(reader.id),startedB=coordinator.start(researcher.id)
  assert.equal(startedA.started,true);assert.equal(startedB.started,true)
  // Wait until the reader has published, then let both run to the end.
  for(let i=0;i<200&&!tasks.db.prepare("SELECT 1 FROM yoyo_team_events WHERE kind='finding'").get();i++)await new Promise(r=>setTimeout(r,5))
  openGate()
  await Promise.all([coordinator.settle(reader.id),coordinator.settle(researcher.id)])
  const seen=Object.fromEntries(log.map(([name,at,extra])=>[name,extra??at]))
  assert.ok(seen['reader-sees-group']<=seen['reader-ends'])
  const received=log.find(([name])=>name==='research-received')
  assert.ok(received,'research branch log: '+JSON.stringify(log))
  assert.equal(received[2],false,'the finding reached the sibling before its author published completion')
  assert.ok(received[1]<=seen['reader-ends'],'the finding was delivered before the author finished')
  const findingId=tasks.db.prepare("SELECT id FROM yoyo_team_events WHERE kind='finding'").get().id
  const completedId=tasks.db.prepare("SELECT id FROM yoyo_team_events WHERE kind='completed' AND from_task=?").get(reader.id).id
  assert.ok(findingId<completedId,'the event order records the sharing before the ending')
  assert.equal(tasks.db.prepare("SELECT state FROM yoyo_team_tasks WHERE id=?").get(reader.id).state,'completed')
  assert.equal(tasks.db.prepare("SELECT state FROM yoyo_team_tasks WHERE id=?").get(researcher.id).state,'completed')
  assert.equal(social.sessionId,'main')
  assert.ok(view.focus)
})

test('a changed direction reaches the branches already working on the activity',t=>{
  const {tasks,view,create,activity,social}=fixture(t)
  const host=new TeamHost(social,{})
  t.after(()=>host.stop())
  const reader=create('读群'),researcher=create('查资料')
  tasks.claim(reader.id,'worker-reader');tasks.claim(researcher.id,'worker-research')
  // The subject narrows the goal while both branches are still running.
  const updated=host.social.data.updateActivity(view.id,{activityId:activity.activityId,revision:1,goal:'只确认今晚是否开服'})
  const announced=host.announceDirection(view.id,{activityId:activity.activityId,goal:'只确认今晚是否开服',state:updated.state,revision:updated.revision})
  assert.ok(announced.eventId)
  // Re-announcing the same revision is not a second instruction.
  assert.equal(host.announceDirection(view.id,{activityId:activity.activityId,goal:'只确认今晚是否开服',state:updated.state,revision:updated.revision}).duplicate,true)
  for(const task of [reader,researcher]){
    const events=tasks.drainEvents(task.id)
    assert.equal(events[0].kind,'direction_changed')
    assert.equal(events[0].baseRevision,2)
    assert.match(events[0].body,/只确认今晚是否开服/)
  }
  // A result written against the old revision cannot complete the new goal.
  assert.throws(()=>host.social.data.updateActivity(view.id,{activityId:activity.activityId,revision:1,state:'done'}),/第 2 版/)
  assert.equal(host.social.data.activities(view.id)[0].state,'active')
})

test('a contradiction gets a recorded ruling instead of a silent overwrite',t=>{
  const {tasks,view,create,wechat}=fixture(t)
  const reader=create('读群'),researcher=create('查资料')
  tasks.claim(reader.id,'worker-reader');tasks.claim(researcher.id,'worker-research')
  // Two branches describe the same page differently.
  tasks.evidence('worker-reader',{kind:'finding',body:'页面写着今晚开服',source:'https://example.com/a'})
  tasks.evidence('worker-research',{kind:'finding',body:'页面写着明天开服',source:'https://example.com/a'})
  let registry=tasks.sourceRegistry(view.id)
  assert.equal(registry[0].conflict,true)
  assert.equal(registry[0].distinct,2)
  assert.equal(registry[0].decision,null)
  // Both readings survive the ruling; the ruling is appended with its reason.
  const ruling=tasks.decideSource(view.id,{source:'https://example.com/a',decision:'verified',chosenBody:'今晚开服',reason:'逐字复核了页面时间戳'})
  assert.ok(ruling.id)
  registry=tasks.sourceRegistry(view.id)
  assert.equal(registry[0].decision,'verified')
  assert.equal(registry[0].chosenBody,'今晚开服')
  assert.equal(registry[0].conflict,true,'the disagreement stays visible as history')
  assert.equal(tasks.board(view.id,{taskId:reader.id}).length,1)
  // A branch working on the activity hears the ruling at its next boundary.
  const heard=tasks.drainEvents(researcher.id).filter(event=>String(event.ref)==='https://example.com/a')
  assert.ok(heard.some(event=>/认定采纳/.test(event.body)))
  // A later ruling supersedes without deleting the earlier one.
  tasks.decideSource(view.id,{source:'https://example.com/a',decision:'unresolved',reason:'再核对发现时区不明'})
  assert.equal(tasks.sourceRegistry(view.id)[0].decision,'unresolved')
  assert.equal(tasks.db.prepare('SELECT count(*) n FROM yoyo_team_source_decisions WHERE source=?').get('https://example.com/a').n,2)
  // Only a view that can see the source may rule on it, and verified needs a body.
  assert.throws(()=>tasks.decideSource(wechat().id,{source:'https://example.com/a',decision:'refuted',reason:'x'}),/范围/)
  assert.throws(()=>tasks.decideSource(view.id,{source:'https://example.com/a',decision:'verified',reason:'x'}),/采纳/)
  assert.throws(()=>tasks.decideSource(view.id,{source:'https://example.com/a',decision:'refuted',chosenBody:'x',reason:'y'}),/采纳内容/)
})

test('the admin timeline shows what moved between branches without their text',t=>{
  const {tasks,view,create,social}=fixture(t)
  const host=new TeamHost(social,{})
  t.after(()=>host.stop())
  const reader=create('读群'),sibling=create('查证')
  tasks.claim(reader.id,'worker-reader');tasks.claim(sibling.id,'worker-sibling')
  tasks.evidence('worker-reader',{kind:'finding',body:'CANARY 群里说了新玩法',source:'群消息2'})
  const asked=tasks.ask(reader.id,{toTask:sibling.id,question:'CANARY 那个游戏叫什么',viewId:view.id})
  const status=host.status()
  const question=status.timeline.find(event=>event.kind==='question')
  assert.ok(question,'the timeline records the question')
  assert.equal(question.openQuestion,true)
  assert.equal(question.to,sibling.id)
  assert.equal(JSON.stringify(status).includes('CANARY'),false,'the panel never carries event or report text')
  assert.equal(status.tasks.find(task=>task.id===sibling.id).waitingFor,1,'the panel shows who is waiting for an answer')
  tasks.answer(sibling.id,{questionEventId:asked.eventId,answer:'叫双人地牢',viewId:view.id})
  const after=host.status()
  assert.equal(after.timeline.find(event=>event.eventId===asked.eventId).openQuestion,false)
  assert.equal(after.tasks.find(task=>task.id===sibling.id).waitingFor,0)
})

test('a branch waits in the host for a sibling instead of finishing early',async t=>{
  const {tasks,view,create}=fixture(t)
  const asker=create('读群'),sibling=create('查证')
  tasks.claim(asker.id,'worker-asker');tasks.claim(sibling.id,'worker-sibling')
  // The wait starts before anything is published, the way a real parallel run
  // looks when the asker is still working.
  const pending=tasks.waitForEvent(sibling.id,{seconds:5,pollMs:5})
  await new Promise(resolve=>setTimeout(resolve,20))
  tasks.publishEvent({fromTask:asker.id,toTask:sibling.id,kind:'question',body:'那个游戏叫什么',viewId:view.id})
  const got=await pending
  assert.equal(got.timedOut,false)
  assert.equal(got.events.length,1)
  assert.equal(got.events[0].kind,'question')
  // Waiting is delivery: the event is not handed over a second time.
  assert.deepEqual(tasks.drainEvents(sibling.id),[])
  // Nothing to receive: the host says so instead of the model polling.
  const idle=await tasks.waitForEvent(sibling.id,{seconds:1,pollMs:20})
  assert.equal(idle.timedOut,true)
  assert.deepEqual(idle.events,[])
  assert.match(idle.note,/没有可领取/)
  // An event addressed to someone else does not end my wait.
  const other=create('另一个')
  const waiting=tasks.waitForEvent(sibling.id,{seconds:1,pollMs:20})
  tasks.publishEvent({fromTask:asker.id,toTask:other.id,kind:'question',body:'给别人的',viewId:view.id})
  assert.equal((await waiting).timedOut,true)
  // The wait is bounded.
  await assert.rejects(()=>tasks.waitForEvent(sibling.id,{seconds:0}),/等待时长/)
  await assert.rejects(()=>tasks.waitForEvent(sibling.id,{seconds:31}),/等待时长/)
})

test('a restart resumes from the acknowledged position instead of replaying',t=>{
  const {tasks,view,create,data}=fixture(t)
  const reader=create('读群'),researcher=create('查资料')
  tasks.claim(reader.id,'worker-reader');tasks.claim(researcher.id,'worker-research')
  const event=tasks.publishEvent({fromTask:reader.id,toTask:researcher.id,kind:'question',body:'帮我确认一下',viewId:view.id})
  assert.equal(tasks.drainEvents(researcher.id).length,1)
  // A new host over the same database keeps the cursor, so nothing is replayed.
  const revived=new TeamStore(data)
  assert.deepEqual(revived.drainEvents(researcher.id),[])
  assert.equal(revived.db.prepare('SELECT cursor FROM yoyo_team_cursors WHERE task_id=? AND topic=?').get(researcher.id,'task:'+researcher.id).cursor>0,true)
  // An event written while nobody was listening is delivered after the restart.
  tasks.publishEvent({fromTask:reader.id,toTask:researcher.id,kind:'question',body:'第二个问题',viewId:view.id})
  assert.equal(revived.drainEvents(researcher.id).length,1)
  assert.ok(event.eventId)
})
