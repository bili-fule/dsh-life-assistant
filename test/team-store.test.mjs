import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { TeamCoordinator } from '../src/team-coordinator.mjs'
import { TeamMotivation } from '../src/team-motivation.mjs'

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'team-')),store=new Store(join(dir,'test.sqlite')),social=new SocialStore(store)
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  const view=peer=>{const target=social.discover({platform:'qq',account:'1',kind:'private',peer,label:'same'});social.approve(target.handle,true);return social.open(target.handle)}
  const a=view('2'),b=view('3'),team=new TeamStore(social,()=>100)
  const create=(key,v=a,role='chat')=>team.create({key,role,goal:'secret goal',viewId:v.id,expiresAt:1000})
  return {team,social,store,a,b,create}
}
test('parallel task authorities never inherit the current window, reports stay scoped',t=>{  const {team,a,b,create}=fixture(t),x=create('x'),y=create('y',b)
  team.claim(x.id,'worker-x');team.claim(y.id,'worker-y')
  assert.equal(team.authority('worker-x').view.id,a.id)
  assert.equal(team.authority('worker-y').view.id,b.id)
  team.report('worker-x','private finding')
  assert.throws(()=>team.reports(x.id,b.id),/范围/)
  assert.equal(team.reports(x.id,a.id)[0].body,'private finding')
  assert.ok(!JSON.stringify(team.overview()).includes('secret'))
  assert.ok(!JSON.stringify(team.overview()).includes('private finding'))
})
test('single speaker, takeover fences delayed sends and reports',t=>{
  const {team,a,create}=fixture(t),x=create('x'),y=create('y')
  team.claim(x.id,'worker-x')
  assert.throws(()=>team.claim(y.id,'worker-y'),/发言者/)
  assert.equal(team.inspect(y.id,a.id).state,'ready')
  assert.equal(team.authorizeSend('worker-x',a.focus,1),true)
  const generation=team.takeover(a.id,'main',1000)
  assert.equal(generation,2)
  assert.throws(()=>team.authorizeSend('worker-x',a.focus,1),/失效/)
  assert.throws(()=>team.report('worker-x','late'),/失效/)
  assert.equal(team.authorizeSend('main',a.focus,2),true)
})
test('revocation invalidates running authority; private material cannot become public research',t=>{
  const {team,social,a,create}=fixture(t),x=create('x')
  team.claim(x.id,'worker')
  assert.throws(()=>create('research',a,'research'),/公开/)
  social.approve(a.focus,false)
  assert.throws(()=>team.authority('worker'))
  assert.throws(()=>team.authorizeSend('worker',a.focus,1))
})
test('durable authority and reports survive registry reconstruction; completion fences writes',t=>{
  const {team,social,a,create}=fixture(t),x=create('x')
  team.claim(x.id,'worker');team.report('worker','evidence')
  const recovered=new TeamStore(social,()=>100)
  assert.equal(recovered.authority('worker').view.id,a.id)
  assert.equal(recovered.reports(x.id,a.id)[0].body,'evidence')
  recovered.finish('worker')
  assert.throws(()=>team.authorizeSend('worker',a.focus,1),/失效/)
  assert.throws(()=>team.report('worker','late'),/失效/)
})
test('public research coexists with chat; deadlines and duplicate task keys are checked',t=>{
  const {team,social,create}=fixture(t),x=create('x'),publicView=social.publicView(),r=create('r',publicView,'research')
  team.claim(x.id,'chat');team.claim(r.id,'search')
  assert.deepEqual(team.authority('search').view.scopes,['public'])
  assert.equal(create('x').id,x.id)
  assert.throws(()=>team.create({key:'x',role:'chat',goal:'different',viewId:x.view_id,expiresAt:1000}),/冲突/)
  const expired=new TeamStore(social,()=>1001)
  assert.throws(()=>expired.report('search','late'),/失效/)
})
test('takeover authority also expires after window permission changes',t=>{
  const {team,social,a}=fixture(t)
  team.takeover(a.id,'main',1000)
  social.approve(a.focus,false);social.approve(a.focus,true)
  assert.throws(()=>team.authorizeSend('main',a.focus,1))
})
test('coordinator runs chat and research concurrently and enforces role tools',async t=>{
  const {team,social,create}=fixture(t),chat=create('chat'),research=create('research',social.publicView(),'research')
  let release;const gate=new Promise(resolve=>{release=resolve}),seen=[]
  const coordinator=new TeamCoordinator({tasks:team,adapter:{async run({task,invoke}){
    seen.push(task.role)
    await gate
    if(task.role==='chat'){
      await assert.rejects(invoke('web',{}),/权限/)
      await invoke('send',{text:'hello'})
    }else{
      await assert.rejects(invoke('send',{text:'bad'}),/权限/)
      await invoke('web',{url:'https://example.com'})
    }
    await invoke('report',{body:'done'})
  }},tools:{send:async({authorize})=>{authorize();return {queued:true}},web:async()=>({text:'public'})}})
  coordinator.start(chat.id);coordinator.start(research.id)
  await Promise.resolve()
  assert.deepEqual(seen,['chat','research'])
  release()
  const results=await Promise.all([coordinator.settle(chat.id),coordinator.settle(research.id)])
  assert.deepEqual(results,[{state:'completed'},{state:'completed'}])
})
test('cancel while delivery is pending rejects the late dispatch',async t=>{
  const {team,a,create}=fixture(t),chat=create('chat')
  let pending,release;const arrived=new Promise(r=>{pending=r}),gate=new Promise(r=>{release=r});let sent=false
  const coordinator=new TeamCoordinator({tasks:team,adapter:{run:({invoke})=>invoke('send',{text:'late'})},tools:{
    send:async({authorize})=>{pending();await gate;authorize();sent=true;return {}}
  }})
  coordinator.start(chat.id);const done=coordinator.settle(chat.id)
  await arrived;coordinator.cancel(chat.id,a.id);release();await done
  assert.equal(sent,false)
  assert.equal(team.inspect(chat.id,a.id).state,'cancelled')
})
test('motivated delegation preserves reasons, scope and explicit stopping conditions',t=>{
  const {team,social,a,b}=fixture(t),motivation=new TeamMotivation(team)
  const concern=social.concern(a.id,{title:'understand',why:'curiosity',origin:'conversation',next:'ask',doneWhen:'answered',stopWhen:'no interest'})
  const args={key:'motivated',role:'chat',goal:'discuss',viewId:a.id,expiresAt:1000,concernId:concern.id,rationale:'continue discussion while I investigate'}
  const task=motivation.delegate(args)
  assert.equal(motivation.delegate(args).id,task.id)
  assert.throws(()=>motivation.delegate({...args,key:'other',viewId:b.id}),/关切/)
  assert.deepEqual(motivation.deliberate(b.id).work,[])
  assert.equal(motivation.deliberate(a.id).work[0].stopWhen,'no interest')
  team.claim(task.id,'worker');team.report('worker','I think solved');team.finish('worker')
  const report=team.reports(task.id,a.id)[0]
  const review=motivation.review(a.id,{taskId:task.id,decision:'wait',reason:'need evidence',reportId:report.id})
  assert.equal(review.evidence,'worker_report')
  assert.equal(review.automaticallyScheduled,false)
  assert.equal(social.concerns(a.id)[0].state,'active')
  assert.throws(()=>motivation.review(b.id,{taskId:task.id,decision:'done',reason:'bad'}),/范围/)
  social.concern(a.id,{id:concern.id,state:'abandoned'})
  assert.throws(()=>motivation.delegate({...args,key:'new'}),/活跃/)
})

test('a task evidence board stays inside the task view and steering is consumed once',t=>{
  const {team,a,b,create}=fixture(t),x=create('x'),y=create('y',b)
  team.claim(x.id,'worker-x');team.claim(y.id,'worker-y')
  const shared=team.evidence('worker-x',{kind:'finding',body:'只在这个窗口读到的材料',source:'event:42'})
  assert.equal(shared.taskId,x.id)
  assert.equal(team.board(a.id,{taskId:x.id}).length,1)
  assert.equal(team.board(a.id,{taskId:x.id})[0].body,'只在这个窗口读到的材料')
  assert.deepEqual(team.board(b.id),[])
  assert.throws(()=>team.board(b.id,{taskId:x.id}),/范围/)
  assert.throws(()=>team.evidence('nobody',{body:'伪造的证据'}),/授权/)
  assert.throws(()=>team.evidence('worker-x',{kind:'rumour',body:'x'}),/证据类型/)
  // The worker's own board never leaks another task's material.
  assert.deepEqual(team.board(b.id,{taskId:y.id}),[])
  assert.equal(team.steer(a.id,{taskId:x.id,message:'顺便看一下评论区'}).delivered,false)
  assert.deepEqual(team.takeSteers('worker-x'),['顺便看一下评论区'])
  assert.deepEqual(team.takeSteers('worker-x'),[])
  team.finish('worker-x')
  assert.throws(()=>team.steer(a.id,{taskId:x.id,message:'太晚了'}),/进行中/)
  assert.throws(()=>team.steer(b.id,{taskId:x.id,message:'越范围'}),/范围/)
})
