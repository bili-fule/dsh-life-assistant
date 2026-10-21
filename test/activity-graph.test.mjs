import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { OrchestrationMetrics } from '../src/orchestration-metrics.mjs'

// The graph answers the five questions the plan asks of it, and it answers them
// from an index of real records: reasons, direction changes, rulings, open
// questions and dependencies - never a model's hidden reasoning.
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'activity-graph-')),store=new Store(join(root,'test.sqlite')),data=new SocialStore(store)
  const metrics=new OrchestrationMetrics(store.db)
  const social={store,data,separate:true,sessionId:'main',qq:null,metrics,config:{quietMs:5000}}
  const host=new TeamHost(social,{enabled:true})
  const target=data.discover({platform:'qq',account:'1',kind:'private',peer:'2'})
  data.approve(target.handle,true)
  const view=data.open(target.handle)
  store.set('yoyo_settings',{observeOnly:false,dailySteps:1000})
  const evidenceCalls=[]
  host.coordinator.adapter={run:async({agentId,task,invoke})=>{
    await invoke('evidence',{kind:'source',body:'星洛说她这周在准备比赛',source:'群消息 #12'})
    await invoke('evidence',{kind:'finding',body:'她提到周四晚上有空',source:'群消息 #14'})
    evidenceCalls.push(task.goal)
    await invoke('finish',{decision:'completed',reason:'读完了'})
    return {}
  }}
  t.after(async()=>{await host.stop();store.close();rmSync(root,{recursive:true,force:true})})
  return {store,data,social,host,view,evidenceCalls}
}

test('the graph answers why, what changed, who verified and what is still unknown',async t=>{
  const {data,host,view,evidenceCalls}=fixture(t)
  const activity=data.startActivity(view.id,{goal:'去 xmfu 看星洛',why:'我答应过她这周去看看'})
  const first=host.intents.create({activityId:activity.activityId,goal:'读群里的近况',why:'先知道她在忙什么',capabilities:['read'],priority:20,viewId:view.id})
  const second=host.intents.create({activityId:activity.activityId,goal:'据此决定要不要搭话',why:'要用上面读到的内容',capabilities:['read'],priority:10,dependsOn:[first.id],viewId:view.id})
  // Queued work is an open item, not a conclusion: the graph says so before any
  // branch has run.
  const before=host.graph.why(view.id,{activityId:activity.activityId}).activities[0]
  assert.equal(before.unknowns.queuedIntents.some(intent=>intent.id===second.id),true)
  assert.equal(before.evidenceCount,0)
  // Let the first branch really run: its evidence is what the graph must find.
  for(let i=0;i<400&&host.intents.get(first.id).state!=='completed';i++){host.tick();await new Promise(resolve=>setTimeout(resolve,5))}
  assert.equal(evidenceCalls.length>=1,true)
  host.announceDirection(view.id,{activityId:activity.activityId,goal:'先去群里看看她最近在忙什么',state:'active',revision:2})
  host.tasks.decideSource(view.id,{source:'群消息 #12',decision:'verified',chosenBody:'星洛在准备比赛',reason:'原文写得明确'})
  host.tasks.decideSource(view.id,{source:'群消息 #14',decision:'unresolved',reason:'只有一句“有空”，对象不明'})
  const answer=host.graph.why(view.id,{activityId:activity.activityId})
  assert.equal(answer.activities.length,1)
  const entry=answer.activities[0]
  assert.equal(entry.goal,'去 xmfu 看星洛')
  assert.match(entry.why,/答应过她/)
  assert.equal(entry.directionChanges.length,1,'a direction change is a recorded fact, not a memory')
  assert.equal(entry.verified.some(row=>row.decision==='verified'&&row.chosen==='星洛在准备比赛'),true)
  assert.deepEqual(entry.unresolved,['群消息 #14'])
  assert.equal(entry.dependsOn.some(row=>row.intentId===second.id&&row.dependsOn===first.id),true)
  assert.equal(entry.branchStates.some(state=>state.state==='completed'),true)
  assert.equal(entry.evidenceCount>=2,true)
  const shaped=host.graph.shape(view.id,{activityId:activity.activityId})
  const kinds=new Set(shaped.nodes.map(node=>node.kind))
  for(const kind of ['activity','intent','task','observation','decision'])assert.equal(kinds.has(kind),true,kind+' appears in the graph')
  assert.equal(shaped.edges.some(edge=>edge.kind==='produced'),true)
  assert.equal(shaped.edges.some(edge=>edge.kind==='supersedes'),true)
  // A ruling of refuted is a disagreement in the graph, never silent support.
  host.tasks.decideSource(view.id,{source:'群消息 #14',decision:'refuted',reason:'后来她自己否认了'})
  const again=host.graph.why(view.id,{activityId:activity.activityId}).activities[0]
  assert.equal(again.verified.some(row=>row.source==='群消息 #14'&&row.decision==='refuted'),true)
})

test('the graph only shows what the current view can read',async t=>{
  const {data,host,view}=fixture(t)
  const activity=data.startActivity(view.id,{goal:'只属于这个窗口',why:'私人'})
  host.intents.create({activityId:activity.activityId,goal:'读群',why:'因为答应了',capabilities:['read'],viewId:view.id})
  for(let i=0;i<400&&host.intents.list({activityId:activity.activityId}).every(intent=>intent.state==='completed');i++){host.tick();await new Promise(resolve=>setTimeout(resolve,5))}
  const other=data.discover({platform:'wechat',account:'bound',kind:'owner',peer:'77'})
  data.approve(other.handle,true)
  const otherView=data.open(other.handle)
  const filtered=host.graph.why(otherView.id)
  assert.equal(filtered.activities.some(entry=>entry.activityId===activity.activityId),false,'another platform is another subject: its graph does not include this activity')
})
