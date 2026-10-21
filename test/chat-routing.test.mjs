import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { OrchestrationMetrics } from '../src/orchestration-metrics.mjs'

// Follow-up messages in a window that already has a chat executor are that
// executor's work. These tests pin the host path: the process is released while
// waiting, a real new message wakes the same identity and session, and nothing
// wakes on an empty window or a full concurrency slot.
const until=async(predicate,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,5))}return false}
const agentOf=id=>'worker-'+createHash('sha256').update(id).digest('hex').slice(0,20)
function fixture(t,{maxConcurrent=2}={}){
  const root=mkdtempSync(join(tmpdir(),'chat-routing-')),store=new Store(join(root,'test.sqlite')),data=new SocialStore(store)
  const metrics=new OrchestrationMetrics(store.db)
  const social={store,data,separate:true,sessionId:'main',qq:null,metrics,config:{quietMs:5000}}
  const host=new TeamHost(social,{enabled:true})
  host.coordinator.maxConcurrent=maxConcurrent
  const target=data.discover({platform:'qq',account:'1',kind:'private',peer:'2'})
  data.approve(target.handle,true)
  const view=data.open(target.handle)
  store.set('yoyo_settings',{observeOnly:false,dailySteps:1000})
  const calls=[]
  // The fake runtime is the only stand-in: claim, lease, pause and wake are the
  // real host code paths.
  host.coordinator.adapter={async run({agentId,task,invoke}){
    calls.push({agentId,task,wake:task.wake??null})
    if(task.wake){await invoke('finish',{decision:'completed',reason:'read the follow-up messages'});return {}}
    await invoke('pause',{reason:'等对方接着说'});return {}
  }}
  const message=(text,at=Date.now()-6000)=>data.ingest({target:view.focus,sender:'2',externalId:'m-'+text+'-'+Math.random(),text,receivedAt:at})
  t.after(async()=>{await host.stop();store.close();rmSync(root,{recursive:true,force:true})})
  return {store,data,social,host,view,target,metrics,calls,message}
}

test('a suspended chat activity is woken by real messages, with the message ids',async t=>{
  const {data,host,view,metrics,calls,message}=fixture(t)
  message('preexisting question')
  const task=host.tasks.create({key:'chat-1',role:'chat',goal:'接话',viewId:view.id,expiresAt:Date.now()+600000})
  assert.equal(host.tasks.inspect(task.id,view.id).chat_through>0,true,'a new chat task starts after what is already there')
  const started=host.coordinator.start(task.id)
  assert.equal(started.started,true)
  await host.coordinator.settle(task.id)
  const suspended=host.tasks.inspect(task.id,view.id)
  assert.equal(suspended.state,'suspended')
  assert.equal(suspended.paused_reason,'等对方接着说')
  assert.equal(host.ownsWindow(view.focus),true,'the window belongs to the branch while it is suspended')
  // The speaker lease goes back, so the subject is not locked out meanwhile.
  assert.equal(host.db.prepare('SELECT expires_at FROM yoyo_team_speakers WHERE target=?').get(view.focus).expires_at,0)
  const afterPause=calls.length
  host.tick()
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(calls.filter(call=>call.wake).length,0,'a quiet window does not wake anybody')
  const first=message('接上了，你继续说'),second=message('刚说到第二点')
  const newest=data.db.prepare("SELECT max(id) id FROM yoyo_events WHERE target=?").get(view.focus).id
  host.tick()
  assert.equal(await until(()=>calls.filter(call=>call.wake).length===1),true,'the burst wakes the executor')
  const wake=calls.find(call=>call.wake)
  assert.equal(wake.task.wake.kind,'new_messages')
  assert.equal(wake.task.wake.count,2)
  assert.equal(wake.task.wake.after,suspended.chat_through)
  assert.equal(wake.task.wake.through,newest)
  assert.notEqual(first,undefined);assert.notEqual(second,undefined)
  assert.equal(wake.agentId,started.agentId,'the same executor identity, so the same native session')
  assert.equal(await until(()=>host.tasks.inspect(task.id,view.id).state==='completed'),true)
  // The same brief is not replayed for messages already handed over.
  host.tick()
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(calls.filter(call=>call.wake).length,1)
  assert.equal(host.ownsWindow(view.focus),false)
  assert.equal(metrics.summary().counts.chat_routed_to_executor,1)
  assert.ok(calls.length>=afterPause)
})

test('a new message that arrives during the run costs one more wake and is never lost',async t=>{
  const {host,view,calls,message}=fixture(t)
  const task=host.tasks.create({key:'chat-2',role:'chat',goal:'接话',viewId:view.id,expiresAt:Date.now()+600000})
  host.coordinator.start(task.id)
  // A message lands while the executor is still working; it is not part of the
  // batch the branch was woken for.
  message('在你回答的时候我又想到一件事')
  await host.coordinator.settle(task.id)
  host.tick()
  assert.equal(await until(()=>calls.filter(call=>call.wake).length===1),true)
  assert.equal(calls.find(call=>call.wake).task.wake.count,1)
  assert.equal(host.tasks.inspect(task.id,view.id).wake_count,1)
})

test('no free executor slot leaves the message queued instead of forcing the subject to do it',async t=>{
  const {host,view,calls,message}=fixture(t,{maxConcurrent:1})
  const gate={release:null}
  host.coordinator.adapter={run:async({agentId,task,invoke})=>{
    calls.push({agentId,task,wake:task.wake??null})
    if(task.wake){await invoke('finish',{decision:'completed',reason:'done'});return {}}
    await new Promise(resolve=>{gate.release=resolve})
    await invoke('finish',{decision:'completed',reason:'other work'})
  }}
  const other=host.tasks.create({key:'other',role:'reader',goal:'读材料',viewId:view.id,expiresAt:Date.now()+600000})
  const chat=host.tasks.create({key:'chat-3',role:'chat',goal:'接话',viewId:view.id,expiresAt:Date.now()+600000})
  host.coordinator.start(other.id)
  assert.equal(await until(()=>gate.release!==null),true,'the other task really holds the only slot')
  host.tasks.claim(chat.id,agentOf(chat.id))
  host.tasks.pause(agentOf(chat.id),'等其他消息')
  message('还有人在吗')
  host.tick()
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(calls.filter(call=>call.wake).length,0,'a full slot queues the message')
  gate.release()
  await host.coordinator.settle(other.id)
  host.tick()
  assert.equal(await until(()=>calls.filter(call=>call.wake).length===1),true,'and it is delivered as soon as a slot frees up')
})

test('an expired suspension ends the activity instead of waking forever',async t=>{
  const {host,view,calls,message}=fixture(t)
  const task=host.tasks.create({key:'chat-4',role:'chat',goal:'接话',viewId:view.id,expiresAt:Date.now()+60000})
  host.tasks.claim(task.id,agentOf(task.id))
  host.tasks.pause(agentOf(task.id),'等回复')
  message('迟到很久的回复')
  host.db.prepare('UPDATE yoyo_team_tasks SET expires_at=? WHERE id=?').run(Date.now()-1,task.id)
  host.tick()
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(calls.filter(call=>call.wake).length,0)
  assert.equal(host.tasks.inspect(task.id,view.id).state,'cancelled')
})

test('only chat and peer tasks may suspend themselves',async t=>{
  const {host,view}=fixture(t)
  const task=host.tasks.create({key:'reader-1',role:'reader',goal:'只读',viewId:view.id,expiresAt:Date.now()+60000})
  host.tasks.claim(task.id,agentOf(task.id))
  assert.throws(()=>host.tasks.pause(agentOf(task.id),'等等看'),/聊天类/)
})
