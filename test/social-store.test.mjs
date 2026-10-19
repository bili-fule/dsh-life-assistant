import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { SocialAgent } from '../src/social-agent.mjs'

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'yoyo-')),store=new Store(join(dir,'data.sqlite')),data=new SocialStore(store);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});const target=(peer,kind='private')=>{const target=data.discover({platform:'qq',account:'10001',kind,peer,label:'相同昵称'});return data.approve(target.handle,true)};return {store,data,target}}

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
