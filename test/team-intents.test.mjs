import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { TeamIntents } from '../src/team-intents.mjs'
import { OrchestrationMetrics } from '../src/orchestration-metrics.mjs'

// The queue is the authority for "work that should happen": the subject states the
// intent, the host decides when it may start. These tests pin ordering, dedupe,
// dependencies, priority aging, real slot limits and the attempt record.
function fixture(t,{maxConcurrent=2}={}){
  const root=mkdtempSync(join(tmpdir(),'team-intents-')),store=new Store(join(root,'test.sqlite')),data=new SocialStore(store)
  const metrics=new OrchestrationMetrics(store.db)
  const social={store,data,separate:true,sessionId:'main',qq:null,metrics,config:{quietMs:5000}}
  const host=new TeamHost(social,{enabled:true})
  host.coordinator.maxConcurrent=maxConcurrent
  const target=data.discover({platform:'qq',account:'1',kind:'private',peer:'2'})
  data.approve(target.handle,true)
  const view=data.open(target.handle)
  store.set('yoyo_settings',{observeOnly:false,dailySteps:1000})
  const calls=[]
  host.coordinator.adapter={run:async({agentId,task,invoke})=>{calls.push({agentId,task});await invoke('finish',{decision:'completed',reason:'done'});return {}}}
  t.after(async()=>{await host.stop();store.close();rmSync(root,{recursive:true,force:true})})
  return {store,data,social,host,view,target,metrics,calls,intents:host.intents}
}

test('an intent needs real capabilities and the same purpose is one intent',async t=>{
  const {intents,view}=fixture(t)
  const made=intents.create({goal:'去 xmfu 看星洛在聊什么',why:'我想知道她最近在忙什么',capabilities:['read','web'],priority:40,viewId:view.id})
  assert.equal(made.state,'ready')
  assert.equal(made.revision,1)
  const again=intents.create({goal:'去 xmfu 看星洛在聊什么',why:'我想知道她最近在忙什么',capabilities:['web','read'],priority:40,viewId:view.id})
  assert.equal(again.reused,true,'the same activity, window, capabilities and goal is one intent')
  assert.equal(again.id,made.id)
  assert.throws(()=>intents.create({goal:'g',why:'w',capabilities:['teleport'],viewId:view.id}),/未知的能力/)
  assert.throws(()=>intents.create({goal:'g',why:'w',capabilities:[],viewId:view.id}),/能力/)
  // A finished attempt may be tried again, as a visible new revision.
  intents.note(made.id,'completed','做完了')
  const revised=intents.create({goal:'去 xmfu 看星洛在聊什么',why:'这回是另一件事',capabilities:['read','web'],viewId:view.id})
  assert.equal(revised.revision,2)
  assert.notEqual(revised.id,made.id)
})

test('the queue orders by priority plus waiting, and honours dependencies and start time',async t=>{
  const {intents,view}=fixture(t)
  const now=Date.now()
  const low=intents.create({goal:'慢慢看',why:'不着急',capabilities:['read'],priority:5,viewId:view.id})
  const high=intents.create({goal:'马上核对',why:'对方在等',capabilities:['verify'],priority:15,viewId:view.id})
  const later=intents.create({goal:'晚点再说',why:'等一个时机',capabilities:['read'],priority:99,notBefore:now+60000,viewId:view.id})
  const order=intents.ready({now}).map(intent=>intent.id)
  assert.deepEqual(order,[high.id,low.id],'priority orders the queue, and a future start time keeps an item out of it')
  assert.equal(order.includes(later.id),false)
  const queue=intents.list({limit:10,now})
  assert.equal(queue.length,3)
  assert.equal(intents.ready({now:now+120000}).length>=1,true)
  assert.equal(intents.ready({now}).some(intent=>intent.id===later.id),false,'a start time in the future keeps it queued')
  // Aging: a low priority item that has waited long enough outranks a fresher high one.
  const old=Date.now()-3600000
  intents.db.prepare('UPDATE yoyo_intents SET created_at=?,not_before=NULL WHERE id=?').run(old,low.id)
  const aged=intents.ready({now}).map(intent=>intent.id)
  assert.equal(aged[0],low.id,'waiting long enough lifts a low priority item above an urgent fresh one')
  // Dependencies gate the queue, and only completion releases it.
  const dependent=intents.create({goal:'据此行动',why:'要用上面的结果',capabilities:['read'],priority:100,dependsOn:[low.id],viewId:view.id})
  assert.equal(intents.ready({now}).some(intent=>intent.id===dependent.id),false)
  intents.note(low.id,'completed','done')
  assert.equal(intents.ready({now}).some(intent=>intent.id===dependent.id),true)
  assert.equal(intents.ready({now}).some(intent=>intent.id===high.id),true)
})

test('token usage is recorded as a measurement, and an unreported run is not zero',async t=>{
  const {host,view,metrics}=fixture(t)
  const settle=async(predicate,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){host.tick();if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,5))}return false}
  host.coordinator.adapter={run:async({invoke})=>{await invoke('usage',{tokens:1234,reported:true});await invoke('finish',{decision:'completed',reason:'done'});return {}}}
  const metered=host.tasks.create({key:'usage-metered',role:'reader',goal:'读数',viewId:view.id,expiresAt:Date.now()+600000})
  host.coordinator.start(metered.id)
  assert.equal(await settle(()=>host.tasks.inspect(metered.id,view.id).state==='completed'),true)
  const usage=host.tasks.usage(metered.id)
  assert.equal(usage.tokens,1234)
  assert.equal(!!usage.tokensReported,true)
  assert.equal(metrics.summary().samples[0].value,1234)
  host.coordinator.adapter={run:async({invoke})=>{await invoke('usage',{tokens:0,reported:false});await invoke('finish',{decision:'completed',reason:'done'});return {}}}
  const unknown=host.tasks.create({key:'usage-unknown',role:'reader',goal:'读数',viewId:view.id,expiresAt:Date.now()+600000})
  host.coordinator.start(unknown.id)
  assert.equal(await settle(()=>host.tasks.inspect(unknown.id,view.id).state==='completed'),true)
  assert.equal(!!host.tasks.usage(unknown.id).tokensReported,false)
  assert.equal(metrics.summary().samples[0].value,null,'an unreported run stays unmeasured, not free')
})

test('the host starts queued work with the narrowest role and follows the attempt to its end',async t=>{
  const {host,intents,view,calls,metrics,data}=fixture(t)
  // The scheduler is the only thing that advances work: every poll here is a real
  // host tick, exactly like the production scheduler loop.
  const settle=async(predicate,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){host.tick();if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,5))}return false}
  const activity=data.startActivity(view.id,{goal:'去 xmfu 看星洛',why:'我想知道她最近在忙什么'})
  const queued=intents.create({goal:'去 xmfu 看星洛在聊什么',why:'我想知道她最近在忙什么',capabilities:['read','web'],priority:50,viewId:view.id,activityId:activity.activityId})
  assert.equal(intents.roleFor(queued),'peer','reading a window and browsing public pages needs a peer')
  assert.equal(await settle(()=>intents.get(queued.id).state==='completed'),true)
  const row=host.tasks.db.prepare('SELECT * FROM yoyo_team_tasks WHERE id=?').get(intents.get(queued.id).task_id)
  assert.equal(row.role,'peer')
  assert.equal(row.goal,'去 xmfu 看星洛在聊什么')
  assert.equal(calls.length,1)
  // The intent and the activity stay connected, and the subject itself executed
  // nothing: the work happened in the branch.
  assert.deepEqual(data.activityLinks(activity.activityId).filter(link=>link.kind==='intent').map(link=>link.ref),[queued.id])
  assert.equal(metrics.summary().counts.subject_exec??0,0,'the subject never ran the heavy work itself')
})

test('a full slot leaves the intent queued and visible instead of pulling the subject in',async t=>{
  const {host,intents,view,calls}=fixture(t,{maxConcurrent:1})
  const gate={release:null}
  host.coordinator.adapter={run:async({agentId,task,invoke})=>{
    calls.push({agentId,task})
    if(task.goal==='占住唯一的额度'){await new Promise(resolve=>{gate.release=resolve})}
    await invoke('finish',{decision:'completed',reason:'done'})
    return {}
  }}
  const busy=intents.create({goal:'占住唯一的额度',why:'长任务',capabilities:['read'],priority:90,viewId:view.id})
  const waiting=intents.create({goal:'等空位的研究',why:'也要做',capabilities:['web'],priority:10,viewId:view.id})
  const settle=async(predicate,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){host.tick();if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,5))}return false}
  host.tick()
  for(let i=0;i<200&&!gate.release;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(calls.length,1)
  host.tick()
  const queued=intents.summary().find(item=>item.id===waiting.id)
  assert.equal(queued.state,'ready')
  assert.equal(queued.waitReason,'等待调度')
  assert.equal(intents.get(waiting.id).task_id,null,'no attempt is created while the slot is full')
  gate.release()
  assert.equal(await settle(()=>intents.get(waiting.id).state==='completed'),true,'the queued work starts as soon as a slot frees up')
  assert.equal(intents.get(busy.id).state,'completed')
})

test('an abandoned intent cancels its branch and stops the queue',async t=>{
  const {host,intents,view}=fixture(t)
  const settle=async(predicate,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){host.tick();if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,5))}return false}
  const ran=intents.create({goal:'要不要继续查',why:'可能没价值',capabilities:['read'],priority:5,viewId:view.id})
  assert.equal(await settle(()=>intents.get(ran.id).state==='completed'),true)
  // A new attempt that is still queued can be dropped with its reason.
  const pending=intents.create({goal:'再查一次',why:'换角度',capabilities:['read'],priority:5,viewId:view.id})
  const cancelled=host.cancelIntent(pending.id,'不值得再查',view)
  assert.equal(cancelled.state,'abandoned')
  assert.equal(cancelled.cancel_reason,'不值得再查')
  assert.equal(intents.ready({now:Date.now()}).some(intent=>intent.id===pending.id),false)
})
