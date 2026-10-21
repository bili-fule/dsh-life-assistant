import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { SocialAgent,SUBJECT_EXECUTION_TOOLS } from '../src/social-agent.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { OrchestrationMetrics } from '../src/orchestration-metrics.mjs'

// The subject's default surface is orchestration. These tests pin the surface
// itself, not a promise in the prompt: the heavy tools are absent, a stale tool
// list cannot execute them, and only a recorded, expiring takeover restores them.
function fixture(t,{team=true}={}){
  const root=mkdtempSync(join(tmpdir(),'yoyo-orchestration-')),store=new Store(join(root,'data.sqlite')),hooks=new Map(),tools=new Map()
  const ctx={on(name,fn){hooks.set(name,fn);return ()=>hooks.delete(name)},systemPrompt:{section(){return ()=>{}},context(){return ()=>{}}},tools:{register(tool){tools.set(tool.name,tool);return ()=>tools.delete(tool.name)}},sessions:{requestViewVersion:1},tokenMeter:{requestViewVersion:1}}
  const runtime={store,abort:new AbortController(),workspace:root,model:{sessionId:'one-agent',async receipt(name,args,exec,body){return body('call:'+exec.callId)}}}
  const agent=new SocialAgent(runtime,ctx,{enabled:true,publicBrowser:true,executor:{}})
  // The team host is the same host used in production; only its social facade is
  // the in-process subject, so this test exercises the real surface rules.
  if(team)agent.team=new TeamHost({store,data:agent.data,separate:true,sessionId:'social',qq:null,metrics:agent.metrics},{enabled:true})
  const target=agent.data.discover({platform:'qq',account:'1000',kind:'private',peer:'123'})
  agent.data.approve(target.handle,true)
  agent.activeView=agent.data.open(target.handle)
  t.after(()=>{agent.stop();store.close();rmSync(root,{recursive:true,force:true})})
  const exec={agent:{id:'one-agent'},signal:runtime.abort.signal,callId:'1',concludeTurn(){}}
  const preExecute=name=>hooks.get('tools/pre-execute')({agent:{id:'one-agent'},name},async()=>({}))
  return {agent,store,tools,hooks,exec,preExecute,root}
}

test('default delegation removes the heavy execution tools from the subject surface',async t=>{
  const {agent,tools,preExecute}=fixture(t)
  const allowed=agent.toolsAllowed()
  assert.equal(allowed.has('yoyo_read'),true,'reading a window stays available')
  assert.equal(allowed.has('team_delegate'),true)
  assert.equal(allowed.has('yoyo_takeover'),true)
  assert.equal(allowed.has('yoyo_handback'),true)
  for(const name of SUBJECT_EXECUTION_TOOLS)assert.equal(allowed.has(name),false,`${name} must be hidden by default`)
  assert.equal(allowed.has('mcp__playwright-mcp__browser_navigate'),false)
  // A tool that is still in a stale list cannot be dispatched either.
  await assert.rejects(()=>preExecute('yoyo_execute'),/yoyo_takeover/)
  await assert.rejects(()=>preExecute('mcp__playwright-mcp__browser_navigate'),/yoyo_takeover/)
  assert.equal(agent.state().orchestration.mode,'delegate')
  assert.equal(agent.state().orchestration.heavyToolsHidden,true)
  assert.equal(tools.get('yoyo_takeover')!==undefined,true)
})

test('without executors the subject keeps its whole surface instead of dead-ending',async t=>{
  const {agent}=fixture(t,{team:false})
  assert.equal(agent.team,null)
  const allowed=agent.toolsAllowed()
  assert.equal(allowed.has('yoyo_execute'),true)
  assert.equal(allowed.has('mcp__playwright-mcp__browser_navigate'),true)
  assert.equal(agent.state().orchestration.mode,'self')
})

test('a takeover is recorded, counted, expiring and revocable',async t=>{
  const {agent,tools,exec,preExecute}=fixture(t)
  const granted=await tools.get('yoyo_takeover').execute({reason:'只有我能核对这个网页的登录状态',minutes:5},exec)
  assert.equal(granted.mode,'takeover')
  assert.equal(granted.expiresAt>Date.now(),true)
  const allowed=agent.toolsAllowed()
  assert.equal(allowed.has('yoyo_execute'),true)
  assert.equal(allowed.has('mcp__playwright-mcp__browser_navigate'),true)
  assert.equal(agent.state().orchestration.mode,'takeover')
  // Dispatch is checked again, and every heavy call is a counted exception.
  await preExecute('yoyo_execute')
  assert.equal(agent.metrics.summary().counts.subject_takeover,1)
  assert.equal(agent.metrics.summary().counts.subject_exec,1)
  const log=agent.takeoverLog()
  assert.equal(log.length,1)
  assert.match(log[0].reason,/登录状态/)
  const released=await tools.get('yoyo_handback').execute({},exec)
  assert.equal(released.released,log[0].id)
  assert.equal(agent.toolsAllowed().has('yoyo_execute'),false)
  assert.equal(agent.takeoverLog()[0].released_by,'subject')
  // An expired grant behaves exactly like no grant, even in the database.
  agent.store.set('yoyo_execution_grant',{id:99,reason:'old',at:1,expiresAt:Date.now()-1})
  assert.equal(agent.executionGrant(),null)
  await assert.rejects(()=>preExecute('yoyo_execute'),/yoyo_takeover/)
})

test('a takeover without a real reason is refused',async t=>{
  const {agent}=fixture(t)
  assert.throws(()=>agent.grantExecution({reason:'   '}),/真实理由/)
  assert.throws(()=>agent.grantExecution({reason:'ok',minutes:0}),/时长/)
  assert.equal(agent.executionGrant(),null)
})

test('follow-up messages in an owned window go to the executor instead of waking the subject',async t=>{
  const {agent,store}=fixture(t)
  store.set('yoyo_started',true)
  const view=agent.activeView,handle=view.focus
  const task=agent.team.tasks.create({key:'chat-owned',role:'chat',goal:'接话',viewId:view.id,expiresAt:Date.now()+600000})
  agent.team.tasks.claim(task.id,'worker-owned')
  assert.equal(agent.team.ownsWindow(handle),true,'while the executor holds the window')
  agent.team.tasks.pause('worker-owned','等对方回复')
  agent.data.ingest({target:handle,sender:'123',externalId:'follow-1',text:'你还没回答我',receivedAt:Date.now()-10000})
  assert.equal(agent.team.ownsWindow(handle),true,'a suspended activity still owns its window')
  assert.equal(agent.choose(Date.now()+agent.config.ordinaryMs+1000),null,'the subject is not asked to approve each follow-up')
  assert.equal(agent.metrics.summary().counts.subject_planned_message??0,0,'a routed message does not count as subject planning')
  // Once the activity is gone the same window reaches the subject again.
  agent.team.coordinator.cancel(task.id,view.id)
  assert.equal(agent.team.ownsWindow(handle),false)
  assert.notEqual(agent.choose(Date.now()+agent.config.ordinaryMs+2000),null)
  assert.equal(agent.metrics.summary().counts.subject_planned_message,1,'now the subject really did plan for a message')
})

test('metrics keep counts, separate latencies and a missing meter apart from zero',()=>{
  const root=mkdtempSync(join(tmpdir(),'yoyo-metrics-')),store=new Store(join(root,'m.sqlite'))
  try{
    const metrics=new OrchestrationMetrics(store.db)
    metrics.count('subject_exec');metrics.count('subject_exec');metrics.count('executor_step',3)
    metrics.time('event_delivery',12);metrics.time('worker_run',400)
    const summary=metrics.summary()
    assert.equal(summary.counts.subject_exec,2)
    assert.equal(summary.counts.executor_step,3)
    assert.deepEqual(summary.timings.worker_run,{samples:1,p50:400,p95:400,max:400})
    assert.equal(summary.timings.event_delivery.p50,12)
    assert.equal(metrics.time('worker_run',-5),null,'a negative duration is dropped, not recorded as instant')
    const missing=metrics.sample('tokens_used',{reported:false,note:'runtime did not report usage'})
    assert.equal(missing.value,null)
    assert.equal(missing.reported,false)
    assert.equal(metrics.summary().samples[0].value,null,'an unreported quantity must not read as a measured 0')
    assert.throws(()=>metrics.count('Bad Key'),/计量键/)
    assert.throws(()=>metrics.time('Bad Key',1),/计量键/)
  }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('event delivery latency is measured when a branch reaches its boundary',()=>{
  const root=mkdtempSync(join(tmpdir(),'yoyo-delivery-')),store=new Store(join(root,'d.sqlite'))
  try{
    const data=new SocialStore(store),metrics=new OrchestrationMetrics(store.db)
    const target=data.discover({platform:'qq',account:'1',kind:'private',peer:'2'});data.approve(target.handle,true)
    const view=data.open(target.handle),tasks=new TeamStore(data,Date.now,metrics)
    const task=tasks.create({key:'latency',role:'reader',goal:'read',viewId:view.id,expiresAt:Date.now()+60000})
    tasks.publishEvent({fromTask:null,activityId:null,kind:'finding',body:'另一分支发现了一个线索',dedupeKey:'latency-1',viewId:view.id})
    const drained=tasks.drainEvents(task.id)
    assert.equal(drained.length,1)
    assert.equal(tasks.drainEvents(task.id).length,0,'the cursor keeps one event from being delivered twice')
    const timing=metrics.summary().timings.event_delivery
    assert.equal(timing.samples,1)
    assert.equal(timing.p50>=0,true)
  }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
