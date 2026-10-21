import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { OrchestrationMetrics } from '../src/orchestration-metrics.mjs'

// Folding narrows attention, it does not delete history: the hot chain keeps every
// unfinished thread, promise and disagreement, and a folded branch can be expanded
// back to its real reports and evidence.
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'branch-folding-')),store=new Store(join(root,'test.sqlite')),data=new SocialStore(store)
  const metrics=new OrchestrationMetrics(store.db)
  const social={store,data,separate:true,sessionId:'main',qq:null,metrics,config:{quietMs:5000}}
  const host=new TeamHost(social,{enabled:true})
  const target=data.discover({platform:'qq',account:'1',kind:'private',peer:'2'})
  data.approve(target.handle,true)
  const view=data.open(target.handle)
  store.set('yoyo_settings',{observeOnly:false,dailySteps:1000})
  host.coordinator.adapter={run:async({agentId,task,invoke})=>{
    await invoke('evidence',{kind:'source',body:'群里提到周四的聚会',source:'群消息 #20'})
    await invoke('report',{body:'读完一次，记下了聚会时间'})
    await invoke('finish',{decision:'completed',reason:'读完了'})
    return {}
  }}
  const settle=async(predicate,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){host.tick();if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,5))}return false}
  t.after(async()=>{await host.stop();store.close();rmSync(root,{recursive:true,force:true})})
  return {store,data,social,host,view,settle}
}

test('the hot chain keeps unfinished work, promises and disagreements',async t=>{
  const {host,view,settle}=fixture(t)
  const activity=host.social.data.startActivity(view.id,{goal:'跟进周四的聚会',why:'我答应了要去'})
  host.social.data.concern(view.id,{title:'别错过周四聚会',why:'答应了别人',origin:'上周聊天里答应的',next:'周三前确认时间',doneWhen:'时间确认',stopWhen:'聚会取消',state:'active'})
  const done=host.intents.create({activityId:activity.activityId,goal:'先看群里约的什么',why:'要知道细节',capabilities:['read'],viewId:view.id})
  assert.equal(await settle(()=>host.intents.get(done.id).state==='completed'),true)
  host.tasks.decideSource(view.id,{source:'群消息 #20',decision:'unresolved',reason:'时间说法有两种'})
  const hot=host.folding.hotChain(view.id)
  assert.equal(hot.activityIds.includes(activity.activityId),true,'the activity is still active, so it stays hot')
  assert.equal(hot.promises.some(promise=>/聚会/.test(promise.title)),true,'an unkept promise stays in front of the subject')
  assert.equal(hot.conflicts.length,1)
  assert.equal(hot.facts.length>=1,true)
})

test('a finished and quiet stretch folds into a summary that points back to its records',async t=>{
  const {host,view,settle}=fixture(t)
  const activity=host.social.data.startActivity(view.id,{goal:'把上次的群读完',why:'当时的兴趣',state:'done'})
  host.social.data.updateActivity(view.id,{activityId:activity.activityId,state:'done'})
  const intent=host.intents.create({activityId:activity.activityId,goal:'读一次上次没看完的群',why:'当时的兴趣',capabilities:['read'],viewId:view.id})
  assert.equal(await settle(()=>host.intents.get(intent.id).state==='completed'),true)
  // Pretend this finished six hours ago.
  const past=Date.now()-7*3600000
  host.intents.db.prepare('UPDATE yoyo_intents SET updated_at=? WHERE id=?').run(past,intent.id)
  const folded=host.folding.fold(view.id,{now:Date.now(),olderThanMs:3600000})
  assert.equal(folded.folded.length,1)
  const listed=host.folding.list(view.id)
  assert.equal(listed.length,1)
  assert.match(listed[0].summary,/读一次上次没看完的群/)
  const expanded=host.folding.expand(view.id,listed[0].id)
  assert.equal(expanded.branches.length,1)
  const attempt=host.intents.get(intent.id).task_id
  assert.equal(expanded.branches[0].taskId,attempt)
  assert.equal(expanded.branches[0].reports.length>=1,true,'the expansion reaches the real report')
  assert.equal(expanded.branches[0].evidence.length>=1,true,'and the real evidence')
  assert.match(expanded.note,/不是新事实/)
  // History is untouched: folding is an attention change, not a deletion.
  assert.ok(host.tasks.inspect(attempt,view.id))
  assert.equal(host.intents.get(intent.id).state,'completed')
})

test('an unresolved disagreement keeps a branch out of the fold',async t=>{
  const {host,view,settle}=fixture(t)
  const activity=host.social.data.startActivity(view.id,{goal:'核对一个说法',why:'两种说法对不上',state:'done'})
  host.social.data.updateActivity(view.id,{activityId:activity.activityId,state:'done'})
  const intent=host.intents.create({activityId:activity.activityId,goal:'读一遍找出原始说法',why:'两种说法对不上',capabilities:['read'],viewId:view.id})
  assert.equal(await settle(()=>host.intents.get(intent.id).state==='completed'),true)
  host.tasks.decideSource(view.id,{source:'群消息 #20',decision:'unresolved',reason:'还没核对完'})
  host.intents.db.prepare('UPDATE yoyo_intents SET updated_at=? WHERE id=?').run(Date.now()-7*3600000,intent.id)
  const folded=host.folding.fold(view.id,{now:Date.now(),olderThanMs:3600000})
  assert.equal(folded.folded.length,0,'a live disagreement is not cold')
  const hot=host.folding.hotChain(view.id)
  assert.equal(hot.conflicts.some(conflict=>conflict.source==='群消息 #20'),true)
})
