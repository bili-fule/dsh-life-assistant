import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialAgent } from '../src/social-agent.mjs'

// Replays the xmfu trajectory: a goal arrives in a private chat, the subject
// says it will go and look, then the window changes. The subject must still know
// why it is in the group, and a polite "I'll take a look" must not count as
// having looked.
function fixture(t,extra={}){
  const root=mkdtempSync(join(tmpdir(),'yoyo-subject-')),store=new Store(join(root,'data.sqlite')),hooks=new Map(),tools=new Map()
  const ctx={on(name,fn){hooks.set(name,fn);return ()=>hooks.delete(name)},systemPrompt:{section(){return ()=>{}},context(){return ()=>{}}},tools:{register(tool){tools.set(tool.name,tool);return ()=>tools.delete(tool.name)}},sessions:{requestViewVersion:1},tokenMeter:{requestViewVersion:1}}
  const runtime={store,abort:new AbortController(),workspace:root,model:{sessionId:'one-agent',async receipt(name,args,exec,body){return body('call:'+exec.callId)}}}
  const agent=new SocialAgent(runtime,ctx,{enabled:true,...extra})
  t.after(()=>{agent.stop();store.close();rmSync(root,{recursive:true,force:true})})
  const target=(peer,kind='private')=>{const row=agent.data.discover({platform:'qq',account:'1000',kind,peer});return agent.data.approve(row.handle,true)}
  let calls=0
  const call=async(name,args)=>{const exec={agent:{id:'one-agent'},signal:runtime.abort.signal,callId:String(++calls),concludeTurn(){}};return tools.get(name).execute(args,exec)}
  return {agent,store,ctx,hooks,tools,target,call,runtime,root}
}

test('a window switch keeps the goal, the reason and the unfinished step',async t=>{
  const {agent,store,target,call}=fixture(t)
  store.set('yoyo_settings',{observeOnly:false})
  const owner=target('1001'),group=target('2002','group'),other=target('3003','group')
  agent.activeView=agent.data.open(owner.handle)

  const started=await call('yoyo_activity',{goal:'去 xmfu 群看看星洛最近在聊什么',why:'私聊里答应了主人',step:'打开群读最近五十条',doneWhen:'读到星洛最近的发言并决定是否参与',stopWhen:'群已解散或星洛不在群里'})
  assert.equal(started.state,'active')
  // The same goal stated twice is one activity, not a second parallel truth.
  assert.equal((await call('yoyo_activity',{goal:'去 xmfu 群看看星洛最近在聊什么'})).activityId,started.activityId)

  agent.data.ingest({target:group.handle,sender:'9001',externalId:'m1',text:'星洛：我最近在玩这个'})
  // The window list comes first: the host refuses to jump to a window the
  // subject has not looked up.
  await call('yoyo_inbox',{})
  await call('yoyo_open',{target:group.handle,activityId:started.activityId})
  // The next native turn applies the selected focus; the subject is the same one.
  agent.activeView=agent.data.open(group.handle)

  const state=agent.state()
  assert.equal(state.focus,group.handle)
  assert.equal(state.currentActivityId,started.activityId)
  assert.equal(state.activities[0].goal,'去 xmfu 群看看星洛最近在聊什么')
  assert.equal(state.activities[0].why,'私聊里答应了主人')
  assert.equal(state.activities[0].step,'打开群读最近五十条')
  // Zero unread in another window is not "the activity is done".
  assert.equal(state.activities[0].state,'active')

  // A different window of the same subject is readable, and the answer to the
  // original private chat is bound to that explicit recipient.
  await call('yoyo_open',{target:other.handle})
  agent.activeView=agent.data.open(other.handle)
  const sent=await call('yoyo_send',{text:'看过了，他在聊一个新游戏',target:owner.handle})
  assert.equal(sent.queued,true)
  assert.equal(agent.data.db.prepare('SELECT target FROM yoyo_outbox WHERE id=?').get(sent.id).target,owner.handle)
  // The subject's own record of the activity is still the one it started with.
  assert.equal(agent.state().activities[0].activityId,started.activityId)
})

test('a compaction re-projects the same subject view instead of keeping a stale one',async t=>{
  const {agent,store,target,call}=fixture(t)
  store.set('yoyo_settings',{observeOnly:false})
  const owner=target('1001'),group=target('2002','group')
  agent.activeView=agent.data.open(owner.handle)
  const started=await call('yoyo_activity',{goal:'把群里的新游戏查清楚',why:'主人问过',step:'先读群原文'})

  // A minimal native session surface: five private messages and one tool call.
  const nodes=[1,2,3,4,5,6],events=[1,2,3,4,5,6].map(seq=>({seq,type:seq===6?'tool/result':'user/message',data:{message:{role:seq===6?'tool':'user',toolCallId:'c1',content:[]}}}))
  for(const seq of nodes)agent.data.labelEvent('one-agent',seq,agent.readView().scopes)
  const session={id:'one-agent',surface:{nodes:[...nodes]},appended:[],append(type,data){this.appended.push({type,data})},snapshotEvents:()=>events.map(event=>({...event}))}
  agent.applyView({session})
  assert.equal(session.appended.length,1)
  assert.deepEqual(session.appended[0].data.visibleSeqs,nodes,'the whole subject history is visible while nothing was compacted')

  // Compaction replaces the surface with a summary node plus the newest message.
  session.surface.nodes=[7,8]
  events.push({seq:7,type:'compaction/summary',data:{message:{role:'assistant',content:[{type:'text',text:'摘要：主人在私聊里让我去看群'}]}}})
  events.push({seq:8,type:'user/message',data:{message:{role:'user',content:[]}}})
  agent.data.labelEvent('one-agent',7,agent.readView().scopes)
  agent.data.labelEvent('one-agent',8,agent.readView().scopes)
  agent.applyView({session})
  assert.equal(session.appended.length,2,'the projection is re-applied after the surface changed')
  assert.deepEqual(session.appended[1].data.visibleSeqs,[7,8])
  // The goal itself never lived in the compacted history: it is still there.
  const state=agent.state()
  assert.equal(state.activities[0].activityId,started.activityId)
  assert.equal(state.activities[0].step,'先读群原文')
  assert.equal(state.currentActivityId,started.activityId)
  // Repeating a step with an unchanged surface does not append again.
  agent.applyView({session})
  assert.equal(session.appended.length,2)
})

test('a restart resumes the same activity instead of an anonymous window',async t=>{
  const {agent,store,target,call,runtime,root}=fixture(t)
  store.set('yoyo_settings',{observeOnly:false})
  const owner=target('1001'),group=target('2002','group')
  agent.activeView=agent.data.open(owner.handle)
  const started=await call('yoyo_activity',{goal:'把星洛提到的新游戏查清楚',why:'主人可能想知道',step:'读群里的原话'})
  agent.data.ingest({target:group.handle,sender:'9001',externalId:'m1',text:'星洛：这游戏叫 XXX'})
  agent.activeView=agent.data.open(group.handle)
  await call('yoyo_activity',{activityId:started.activityId,revision:1,step:'搜索 XXX 的玩法',activityState:'waiting'})
  agent.stop()

  // A fresh process over the same database keeps the goal, the step and its state.
  const revived=new SocialAgent(runtime,{on(){return ()=>{}},systemPrompt:{section(){return ()=>{}},context(){return ()=>{}}},tools:{register(){return ()=>{}}},sessions:{requestViewVersion:1},tokenMeter:{requestViewVersion:1}},{enabled:true})
  t.after(()=>revived.stop())
  revived.activeView=revived.data.open(group.handle)
  const state=revived.state()
  assert.equal(state.currentActivityId,started.activityId)
  assert.equal(state.activities[0].goal,'把星洛提到的新游戏查清楚')
  assert.equal(state.activities[0].step,'搜索 XXX 的玩法')
  assert.equal(state.activities[0].state,'waiting')
})

test('a stale activity revision is refused instead of overwriting a newer plan',async t=>{
  const {agent,target,call}=fixture(t)
  const owner=target('1001')
  agent.activeView=agent.data.open(owner.handle)
  const started=await call('yoyo_activity',{goal:'跟进星洛提到的游戏'})
  const first=await call('yoyo_activity',{activityId:started.activityId,revision:1,step:'先读群原文'})
  assert.equal(first.revision,2)
  await assert.rejects(()=>call('yoyo_activity',{activityId:started.activityId,revision:1,step:'另一条路线'}),/第 2 版/)
  assert.equal(agent.data.activities(agent.activeView.id)[0].step,'先读群原文')
})

test('an unknown activity or a foreign window never becomes the subject state',async t=>{
  const {agent,target,call}=fixture(t)
  const owner=target('1001'),group=target('2002','group')
  agent.activeView=agent.data.open(owner.handle)
  await call('yoyo_inbox',{})
  await assert.rejects(()=>call('yoyo_open',{target:group.handle,activityId:'5f8f6b2e-0000-4000-8000-000000000000'}),/活动不存在/)
  // Opening a window is a position change, and it records no completed work.
  const opened=await call('yoyo_open',{target:group.handle})
  assert.equal(opened.transition,'after_turn')
  assert.equal(agent.data.activities(agent.activeView.id).length,0)
})
