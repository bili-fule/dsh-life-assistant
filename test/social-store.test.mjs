import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { SocialAgent } from '../src/social-agent.mjs'

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'yoyo-')),store=new Store(join(dir,'data.sqlite')),data=new SocialStore(store);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});const target=(peer,kind='private')=>{const target=data.discover({platform:'qq',account:'10001',kind,peer,label:'相同昵称'});return data.approve(target.handle,true)};return {store,data,target}}

test('persistent concerns retain intention and cannot cross private windows',t=>{
  const {data,target}=fixture(t),a=data.open(target('123').handle),b=data.open(target('456').handle)
  const saved=data.concern(a.id,{title:'study',why:'understand',origin:'a question',next:'experiment',doneWhen:'verified result',stopWhen:'no useful progress'})
  assert.equal(data.concerns(a.id)[0].next,'experiment')
  assert.deepEqual(data.concerns(b.id),[])
  assert.throws(()=>data.concern(b.id,{id:saved.id,state:'done'}),/范围/)
  data.concern(a.id,{id:saved.id,state:'abandoned'})
  assert.equal(data.concerns(a.id)[0].state,'abandoned')
  assert.throws(()=>data.concern(a.id,{title:'empty'}))
})

test('self-authored activity cannot prove procedural execution and evidence queries remain bounded',t=>{
 const {data}=fixture(t),v=data.publicView()
 data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('self-report','yoyo_activity',JSON.stringify(v.scopes),'I completed a job',Date.now())
 assert.throws(()=>data.remember(v.id,{kind:'procedures',body:'execution done',sources:[{receipt:'self-report',quote:'completed'}]}),/自述/)
 data.remember(v.id,{kind:'episodes',body:'我曾自述完成任务，尚未验证',confidence:'self_report',sources:[{receipt:'self-report',quote:'completed'}]})
 assert.deepEqual(data.evidence(v.id),[])
 assert.throws(()=>data.evidence(v.id,{limit:21}),/条数/)
})

test('feedback distinguishes a self report from scoped tool evidence and review consumption preserves newer decisions',t=>{
 const {data,target}=fixture(t),a=data.open(target('123').handle),b=data.open(target('456').handle),now=Date.now()
 const c=data.concern(a.id,{title:'experiment',why:'question',origin:'experience',next:'run',doneWhen:'measured',stopWhen:'no progress',reviewAt:now+1000})
 assert.equal(data.concernFeedback(a.id,{id:c.id,outcome:'seems promising',decision:'continue'}).evidence,'self_report')
 data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('private-result','yoyo_job',JSON.stringify(a.scopes),'done',now)
 assert.throws(()=>data.concernFeedback(b.id,{id:c.id,outcome:'read',decision:'done',receipt:'private-result'}),/范围/)
 assert.equal(data.concernFeedback(a.id,{id:c.id,outcome:'job done',decision:'continue',receipt:'private-result'}).evidence,'tool_receipt')
 data.concern(a.id,{id:c.id,reviewAt:now+2000})
 data.consumeConcernReview(c.id,now+1000)
 assert.equal(data.concerns(a.id)[0].reviewAt,now+2000)
 assert.deepEqual(data.concernFeedbacks(b.id),[])
})

test('learning selects one admired identity, requires a real trial before adoption and retains retirement history',t=>{
 const {data,target}=fixture(t),a=target('123'),b=target('456'),v=data.open(a.handle),other=data.open(b.handle)
 const first=data.ingest({target:a.handle,sender:'123',externalId:'learn-1',text:'先把问题说清楚'})
 const second=data.ingest({target:a.handle,sender:'123',externalId:'learn-2',text:'可以一步一步来'})
 const wrong=data.ingest({target:a.handle,sender:'456',externalId:'learn-3',text:'也可以'})
 const forwarded=data.ingest({target:a.handle,sender:'123',externalId:'learn-4',text:'转发',segments:[{type:'forward',data:{id:'f'}}]})
 const fields={trait:'耐心解释',admiration:'欣赏其先澄清再解释的方式',trial:'下一次解释先澄清问题',sources:[{id:first.id,quote:'问题说清楚'},{id:second.id,quote:'一步一步'}]}
 assert.throws(()=>data.learn(v.id,{...fields,state:'adopted',review:'good',trialReceipt:'none'}),/先记录尝试/)
 assert.throws(()=>data.learn(v.id,{...fields,sources:[fields.sources[0],{id:wrong.id,quote:'也可以'}]}),/同一稳定身份/)
 assert.throws(()=>data.learn(v.id,{...fields,sources:[fields.sources[0],{id:forwarded.id,quote:'转发'}]}),/不接受转发/)
 const l=data.learn(v.id,fields)
 assert.deepEqual(data.learning(other.id),[])
 data.learn(v.id,{id:l.id,state:'trial'})
 assert.throws(()=>data.learn(v.id,{id:l.id,state:'adopted',review:'helpful',trialReceipt:'missing'}),/回执/)
 data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('trial-job','yoyo_job',JSON.stringify(v.scopes),JSON.stringify({state:'done'}),Date.now())
 data.learn(v.id,{id:l.id,state:'adopted',review:'这次清晰了一些，仍是自己的判断',trialReceipt:'trial-job'})
 assert.equal(data.learning(v.id)[0].reviewConfidence,'self_report')
 data.learn(v.id,{id:l.id,state:'retired'})
 assert.equal(data.learning(v.id)[0].state,'retired')
 assert.equal(data.db.prepare('SELECT count(*) n FROM yoyo_learning_versions WHERE learning_id=?').get(l.id).n,4)
 assert.throws(()=>data.learn(other.id,{id:l.id,state:'trial'}),/范围/)
})

test('stable accounts separate identical nicknames and duplicate incoming events',t=>{
  const {data,target}=fixture(t),a=target('123'),b=target('456')
  const first=data.ingest({target:a.handle,sender:'123',externalId:'1',text:'PRIVATE_CANARY'})
  assert.equal(data.ingest({target:a.handle,sender:'123',externalId:'1',text:'changed'}).inserted,false)
  data.ingest({target:b.handle,sender:'456',externalId:'1',text:'hello'})
  assert.notEqual(a.handle,b.handle)
  assert.equal(data.read(data.open(a.handle).id)[0].id,first.id)
  assert.equal(data.read(data.open(b.handle).id)[0].text,'hello')
})

test('unified internal attention cannot publish cross-window information',t=>{
  const {data,target}=fixture(t),a=target('123'),b=target('456'),overview=data.planningView()
  assert.throws(()=>data.enqueue(overview.id,b.handle,'private thought','send-1'),/资料|跨|来源/)
  const av=data.open(a.handle),bv=data.open(b.handle)
  data.labelEvent('one-agent',1,av.scopes)
  assert.equal(data.eventVisible('one-agent',1,bv.id),false)
  assert.equal(data.eventVisible('one-agent',1,overview.id),true)
  assert.throws(()=>data.enqueue(av.id,b.handle,'cross target','send-2'))
  assert.equal(data.enqueue(bv.id,b.handle,'hello','send-3').queued,true)
  assert.equal(data.enqueue(bv.id,b.handle,'hello','send-3').id,1)
  assert.throws(()=>data.enqueue(bv.id,b.handle,'different','send-3'),/更换/)
})

test('revocation invalidates old focused and overview views and cancels queued sends',async t=>{
  const {data,target}=fixture(t),a=target('123'),av=data.open(a.handle),overview=data.planningView()
  data.enqueue(av.id,a.handle,'hello','send-1');data.approve(a.handle,false)
  assert.throws(()=>data.view(av.id),/授权/)
  assert.throws(()=>data.view(overview.id),/授权/)
  let called=false;await data.deliver(async()=>{called=true})
  assert.equal(called,false);assert.equal(data.snapshot().outbox[0].state,'cancelled')
  data.approve(a.handle,true);assert.throws(()=>data.view(av.id),/失效/)
})

test('uncertain delivery is never automatically sent again, including restart',async t=>{
  const {data,store,target}=fixture(t),a=target('123'),v=data.open(a.handle)
  data.enqueue(v.id,a.handle,'hello','send-1');let calls=0
  await data.deliver(async()=>{calls++;throw Error('connection lost after write')})
  await new SocialStore(store).deliver(async()=>{calls++;return {messageId:123}})
  assert.equal(calls,1);assert.equal(data.snapshot().outbox[0].state,'uncertain')
})

test('explicit failure can retry while a successful platform receipt finishes once',async t=>{
  const {data,target}=fixture(t),a=target('123'),v=data.open(a.handle),now=Date.now()
  data.enqueue(v.id,a.handle,'hello','send-1',now)
  await data.deliver(async()=>{throw Object.assign(Error('rejected'),{definitelyNotSent:true})},now)
  assert.equal(data.snapshot().outbox[0].state,'retry_wait')
  await data.deliver(async()=>({messageId:'confirmed'}),now+31000)
  assert.equal(data.snapshot().outbox[0].state,'sent')
})

test('memory evidence, expiration, scope and forgetting are enforced outside the model',t=>{
  const {data,target}=fixture(t),a=target('123'),b=target('456'),av=data.open(a.handle),bv=data.open(b.handle)
  const source=data.ingest({target:a.handle,sender:'123',externalId:'1',text:'我喜欢简洁的回复'})
  const memory={kind:'communication',body:'偏好简洁；原因尚不确定',confidence:'hypothesis',sources:[{id:source.id,quote:'喜欢简洁'}]}
  assert.throws(()=>data.remember(bv.id,memory),/逐字证据/)
  assert.throws(()=>data.remember(av.id,{...memory,sources:[{id:source.id,quote:'编造原文'}]}),/逐字证据/)
  const saved=data.remember(av.id,memory)
  assert.equal(data.recall(av.id).length,1);assert.equal(data.recall(bv.id).length,0)
  data.forget(saved.id);assert.equal(data.recall(av.id).length,0)
  assert.throws(()=>data.remember(av.id,memory),/已忘记/)
})

test('reading a filtered page marks only returned original messages as read',t=>{
  const {data,store,target}=fixture(t),a=target('123'),v=data.open(a.handle)
  for(const [key,text] of [['1','match'],['2','other']]){store.ingest(key,'owner',text);const row=store.db.prepare('SELECT id FROM inbox WHERE external_id=?').get(key);data.ingest({target:a.handle,sender:'123',externalId:key,text,sourceInbox:row.id})}
  const messages=data.read(v.id,{query:'match'});data.markRead(v.id,messages.map(m=>m.id))
  assert.equal(data.inbox()[0].unread,1)
  assert.deepEqual(store.db.prepare('SELECT state FROM inbox ORDER BY id').all().map(r=>r.state),['done','pending'])
})

test('changing owner revokes the former binding and an explicit revoke stays revoked',t=>{
  const {store}=fixture(t),agent=new SocialAgent({store,model:{}},null)
  store.set('owner','alice');const a=agent.ownerTarget();assert.equal(a.approved,1)
  agent.data.approve(a.handle,false);assert.equal(agent.ownerTarget(),null)
  store.set('owner','bob');assert.equal(agent.ownerTarget().peer,'bob')
  assert.equal(agent.data.target(a.handle).approved,0)
})

test('own plans and web-supported knowledge inherit host visibility',t=>{
  const {data,target}=fixture(t),a=target('123'),b=target('456'),av=data.open(a.handle),bv=data.open(b.handle),publicView=data.publicView()
  data.plan(av.id,{title:'private project',progress:'private progress'})
  assert.equal(data.plans(bv.id).length,0);assert.equal(data.plans(av.id).length,1)
  assert.throws(()=>data.plan(bv.id,{id:1,title:'take over'}),/资料范围/)
  const document=Number(data.db.prepare('INSERT INTO yoyo_documents(url,body,scope,created_at) VALUES(?,?,?,?)').run('https://example.com','public source','public',Date.now()).lastInsertRowid)
  data.remember(publicView.id,{kind:'knowledge',body:'public learned fact',sources:[{document,quote:'public source'}]})
  assert.equal(data.recall(bv.id)[0].body,'public learned fact')
})


test('attention batches are fixed at five seconds and acknowledging one window preserves another',t=>{
 const {data,target}=fixture(t),a=target('123'),b=target('456'),start=Date.now()
 const put=(chat,id,delta)=>data.ingest({target:chat.handle,sender:chat.peer,externalId:id,text:id,receivedAt:start+delta})
 put(a,'a1',0);put(a,'a2',4000);put(a,'a3',5100);put(b,'b1',1000)
 const batches=data.attention(start+5000,5000),av=batches.find(v=>v.handle===a.handle)
 assert.equal(av.ready,true);assert.equal(av.count,2);assert.equal(batches.find(v=>v.handle===b.handle).ready,false)
 data.acknowledgeAttention([av])
 assert.equal(data.attention(start+5100,5000).find(v=>v.handle===a.handle).ready,false)
 assert.equal(data.attention(start+6000,5000).find(v=>v.handle===b.handle).ready,true)
 assert.equal(data.attention(start+10100,5000).find(v=>v.handle===a.handle).count,1)
})
test('asset outbox pins the original payload and rechecks target revocation before sending',async t=>{
 const {data,target}=fixture(t),a=target('123'),b=target('456'),av=data.open(a.handle),bv=data.open(b.handle)
 data.db.prepare('INSERT INTO yoyo_assets VALUES(?,?,?,?,?)').run('asset-a','image.png',JSON.stringify(av.scopes),'image.png',Date.now())
 const content={assetId:'asset-a',kind:'image',bytes:10,sha256:'a'.repeat(64)}
 assert.throws(()=>data.enqueueAsset(bv.id,b.handle,content,'wrong-scope'),/资料范围/)
 const queued=data.enqueueAsset(av.id,a.handle,content,'asset-send')
 assert.throws(()=>data.enqueueAsset(av.id,a.handle,{...content,sha256:'b'.repeat(64)},'asset-send'),/更换附件/)
 assert.equal(JSON.parse(data.db.prepare('SELECT content FROM yoyo_outbox WHERE id=?').get(queued.id).content).sha256,content.sha256)
 data.approve(a.handle,false);let sent=false
 await data.deliver(async()=>{sent=true;return {messageId:'should-not-send'}})
 assert.equal(sent,false);assert.equal(data.db.prepare('SELECT state FROM yoyo_outbox WHERE id=?').get(queued.id).state,'cancelled')
})


test('verified procedural memories require real tool receipts and inherit their private scope',t=>{
 const {data,target}=fixture(t),a=target('123'),b=target('456'),av=data.open(a.handle),bv=data.open(b.handle)
 const message=data.ingest({target:a.handle,sender:'123',externalId:'a',text:'执行成功'})
 const value={kind:'procedures',body:'实测过的处理流程',confidence:'observed',sources:[{id:message.id,quote:'执行成功'}]}
 assert.throws(()=>data.remember(av.id,value),/实际工具回执/)
 data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('real-receipt','yoyo_job',JSON.stringify(av.scopes),JSON.stringify({exitCode:0,stdout:'selftest passed'}),Date.now())
 const proven={...value,sources:[{receipt:'real-receipt',quote:'selftest passed'}]}
 assert.ok(data.remember(av.id,proven).id)
 assert.throws(()=>data.remember(bv.id,proven),/逐字证据/)
 assert.throws(()=>data.remember(av.id,{...proven,sources:[{receipt:'invented',quote:'passed'}]}),/逐字证据/)
})


test('muted windows retain unread and mentions but cannot trigger attention, including after unmute',t=>{
 const {data,target}=fixture(t),a=target('123','group'),now=Date.now()
 data.setMuted(a.handle,true)
 data.ingest({target:a.handle,sender:'456',externalId:'muted',text:'kept',mentioned:true,receivedAt:now-10000})
 assert.deepEqual(data.attention(now),[])
 const item=data.inbox().find(t=>t.handle===a.handle)
 assert.equal(item.muted,1);assert.equal(item.unread,1);assert.equal(item.mentioned,1)
 assert.equal(data.read(data.open(a.handle).id)[0].text,'kept')
 data.setMuted(a.handle,false);assert.deepEqual(data.attention(now),[])
 data.ingest({target:a.handle,sender:'456',externalId:'new',text:'wake',receivedAt:now})
 assert.equal(data.attention(now+5000)[0].count,1)
})


test('group auto sensitivity increases with traffic and custom thresholds aggregate across batches',t=>{
 const {data,target}=fixture(t),a=target('123','group'),now=Date.now()
 const put=(id,time)=>data.ingest({target:a.handle,sender:'456',externalId:id,text:id,receivedAt:time})
 put('first',now-10000)
 assert.equal(data.attention(now)[0].ready,false)
 assert.equal(data.inbox()[0].unread,1)
 assert.equal(data.attention(now+120000)[0].ready,true)
 data.setAttentionPolicy(a.handle,{mode:'custom',minMessages:4,maxWaitMs:600000,minIntervalMs:60000,mentionBypass:false})
 put('second',now-6000);put('third',now-1000)
 assert.equal(data.attention(now)[0].ready,false)
 put('fourth',now)
 const batch=data.attention(now)[0];assert.equal(batch.ready,true);assert.equal(batch.count,4)
 data.acknowledgeAttention([batch],now)
 for(let i=0;i<4;i++)put('next'+i,now+10000+i)
 assert.equal(data.attention(now+20000)[0].ready,false)
 assert.equal(data.attention(now+60000)[0].ready,true)
 for(let i=0;i<100;i++)put('busy'+i,now-20000)
 data.setAttentionPolicy(a.handle,{mode:'auto'})
 assert.ok(data.attentionPolicy(a.handle,now).minMessages>3)
})

test('temporary real-time attention expires, mentions obey policy and mute always wins',t=>{
 const {data,target}=fixture(t),a=target('123','group'),now=Date.now()
 data.setAttentionPolicy(a.handle,{mode:'custom',minMessages:10,maxWaitMs:600000,mentionBypass:false})
 data.ingest({target:a.handle,sender:'456',externalId:'mention',text:'hi',mentioned:true,receivedAt:now})
 assert.equal(data.attention(now+5000)[0].ready,false)
 data.setAttentionPolicy(a.handle,{mode:'auto',mentionBypass:true})
 assert.equal(data.attention(now+5000)[0].ready,true)
 const policy=data.setAttentionPolicy(a.handle,{mode:'realtime',durationMs:30000})
 assert.equal(data.attention(now+4999)[0].ready,false)
 assert.equal(data.attention(now+5000)[0].ready,true)
 assert.equal(data.attentionPolicy(a.handle,policy.until).mode,'auto')
 data.setMuted(a.handle,true);assert.deepEqual(data.attention(now+5000),[])
 assert.throws(()=>data.setAttentionPolicy(a.handle,{mode:'realtime',durationMs:3600001}),/threshold/)
 assert.throws(()=>data.setAttentionPolicy(target('999').handle,{mode:'auto'}),/groups/)
})


test('presented attention survives window switches until read or deliberately dismissed',t=>{
 const {data,target}=fixture(t),a=target('123'),now=Date.now()
 data.ingest({target:a.handle,sender:'123',externalId:'notice',text:'hello',receivedAt:now-10000})
 data.acknowledgeAttention(data.attention(now),now)
 assert.deepEqual(data.attention(now),[])
 assert.equal(data.pendingNotices()[0].unread,1)
 const view=data.open(a.handle);data.markRead(view.id,data.read(view.id).map(x=>x.id))
 assert.deepEqual(data.pendingNotices(),[])
 data.ingest({target:a.handle,sender:'123',externalId:'next',text:'hey',receivedAt:now})
 data.acknowledgeAttention(data.attention(now+5000),now+5000)
 data.dismissNotice(a.handle);assert.deepEqual(data.pendingNotices(),[])
 assert.equal(data.inbox()[0].unread,1)
})
