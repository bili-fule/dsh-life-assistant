import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync,readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { Batcher } from '../src/batching.mjs'
import { Runtime } from '../src/runtime.mjs'
import { applyAnalysis } from '../src/assistant.mjs'

const start=Date.parse('2026-10-18T12:00:00+08:00')
const analysis={reply:'统一整理完成',tasks:[],updates:[],ignored:[],explicit_memories:[],style_observation:null}
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'life-batch-')),path=join(dir,'db.sqlite'),store=new Store(path),resources=[];t.after(()=>{for(const r of resources)r.close();try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})});return {dir,path,store,batcher:new Batcher(store),track:r=>{resources.push(r);return r}}}
function add(store,text,at,owner='owner'){store.ingest('message-'+store.db.prepare('SELECT count(*) n FROM inbox').get().n,owner,text,at)}

test('a burst waits for silence and late text extends the same batch',t=>{
  const {store,batcher}=fixture(t)
  add(store,'[文件] 通知.pdf',start)
  assert.equal(batcher.ready(start+14000),null)
  add(store,'我是计算机三班，这是我们的通知',start+12000)
  assert.equal(batcher.ready(start+16000),null)
  assert.equal(batcher.ready(start+26999),null)
  assert.deepEqual(batcher.ready(start+27000).map(r=>r.id),[1,2])
})
test('continuous messages flush after a minute or the batch size limit',t=>{
  const {store,batcher}=fixture(t)
  for(let i=0;i<7;i++)add(store,'资料'+i,start+i*10000)
  assert.equal(batcher.ready(start+59999),null)
  assert.equal(batcher.ready(start+60000).length,7)
  assert.equal(new Batcher(store,{batchMaxMessages:3}).ready(start+60000).length,3)
})
test('separate bursts and explicit commands preserve message order without merging',t=>{
  const {store,batcher}=fixture(t)
  add(store,'前一批',start);add(store,'后一批',start+20000);add(store,'/todo',start+21000)
  const first=batcher.ready(start+21000);assert.deepEqual(first.map(r=>r.id),[1]);batcher.claim(first);applyAnalysis(store,first[0],analysis)
  const second=batcher.ready(start+21000);assert.deepEqual(second.map(r=>r.id),[2]);batcher.claim(second);applyAnalysis(store,second[0],analysis)
  assert.deepEqual(batcher.ready(start+21000).map(r=>r.id),[3])
})
test('messages from different owners never share a batch',t=>{
  const {store,batcher}=fixture(t);add(store,'甲的资料',start,'a');add(store,'乙的资料',start+1000,'b')
  assert.deepEqual(batcher.ready(start+16000).map(r=>r.id),[1])
})
test('claimed membership survives restart and newer messages do not enter a retry',t=>{
  const {store,path,track}=fixture(t);let batcher=new Batcher(store)
  add(store,'通知',start);add(store,'补充',start+1000);batcher.claim(batcher.ready(start+16000));store.close()
  const reopened=track(new Store(path));batcher=new Batcher(reopened)
  add(reopened,'后来新收到的消息',start+20000)
  assert.deepEqual(batcher.ready(start+36000).map(r=>r.id),[1,2])
})
test('all messages complete atomically with one reply and rollback together',t=>{
  const {store,batcher}=fixture(t);add(store,'通知',start);add(store,'补充',start+1000)
  const rows=batcher.ready(start+16000);batcher.claim(rows)
  assert.throws(()=>applyAnalysis(store,rows[0],{...analysis,updates:[{id:999,patch:{status:'done'}}]},{batchIds:rows.map(r=>r.id)}))
  assert.ok(store.snapshot().inbox.every(r=>r.state==='processing'));assert.equal(store.snapshot().outbox.length,0)
  applyAnalysis(store,rows[0],analysis,{batchIds:rows.map(r=>r.id)})
  assert.ok(store.snapshot().inbox.every(r=>r.state==='done'));assert.equal(store.snapshot().outbox.length,1)
  assert.equal(JSON.parse(store.snapshot().inbox.find(r=>r.id===2).result).batch_id,1)
})
test('a failed batch retries as a unit even when retry is requested on a child',t=>{
  const {store,batcher}=fixture(t);add(store,'图片',start);add(store,'补充',start+1000)
  let rows=batcher.ready(start+16000);batcher.claim(rows)
  for(let attempt=0;attempt<3;attempt++){rows=batcher.members(1);batcher.fail(rows,Error('test failure'),start+20000)}
  assert.ok(store.snapshot().inbox.every(r=>r.state==='failed'));assert.equal(store.snapshot().outbox.length,1)
  batcher.retry(2);assert.deepEqual(batcher.ready(start+20000).map(r=>r.id),[1,2]);assert.equal(store.snapshot().outbox[0].state,'superseded')
})
test('large combined inputs retain the full original texts in a readable archive',async t=>{
  const {store,batcher,dir}=fixture(t);add(store,'a'.repeat(30000),start);add(store,'b'.repeat(30000),start+1000)
  const rows=batcher.ready(start+16000);const prepared=await batcher.prepare(rows,{async prepare(row){return {text:row.text,assets:[]}}},dir)
  assert.ok(prepared.text.length<48000);const archived=JSON.parse(readFileSync(join(dir,prepared.assets[0].path),'utf8'));assert.equal(archived[1].text.length,30000);assert.match(prepared.text,/超过展示预算/)
})
