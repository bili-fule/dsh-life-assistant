import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { organizeMemory,directSource } from '../src/memory.mjs'
import { Maintenance } from '../src/maintenance.mjs'
import { markdownChunks } from '../src/markdown.mjs'

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'life-memory-')),store=new Store(join(dir,'db.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});return store}
function add(store,text,at=Date.now()-600000){store.ingest('m'+store.db.prepare('SELECT count(*) n FROM inbox').get().n,'owner',text,at);return store.db.prepare('SELECT max(id) id FROM inbox').get().id}
function memory(body,id,quote,replace_ids=[]){return {body,sources:[{id,quote}],replace_ids}}

test('automatic memory needs no remember phrase, preserves evidence and merges corrections',t=>{
  const store=fixture(t),id=add(store,'以后发链接直接给我链接就行，我不喜欢长解释')
  organizeMemory(store,{upserts:[memory('用户喜欢直接给链接、少解释',id,'我不喜欢长解释')]})
  const first=store.memories()[0];assert.equal(first.kind,'learned');assert.equal(store.db.prepare('SELECT quote FROM memory_sources').get().quote,'我不喜欢长解释')
  const next=add(store,'工作的问题还是请详细解释')
  organizeMemory(store,{upserts:[memory('普通链接少解释，工作问题详细解释',next,'工作的问题还是请详细解释',[first.id])]})
  assert.equal(store.memories().length,1);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_sources WHERE memory_id=?').get(store.memories()[0].id).n,2)
})
test('forwarded XML, quoted messages, nonexistent evidence and other senders cannot seed memory',t=>{
  const store=fixture(t);store.set('owner','owner');const id=add(store,'[合并转发资料]\n李四是老师')
  store.captureMessage({message_id:'m0',from_user_id:'owner',item_list:[{text_item:{text:'<recordinfo><text>李四是老师</text></recordinfo>'}}]})
  assert.equal(directSource(store,id).direct_text,'')
  assert.throws(()=>organizeMemory(store,{upserts:[memory('用户是老师',id,'李四是老师')]}),/直接消息/)
  const direct=add(store,'我喜欢简短回答')
  assert.throws(()=>organizeMemory(store,{upserts:[memory('用户是医生',direct,'我是医生')]}),/直接消息/)
  store.ingest('other','stranger','我是医生');assert.throws(()=>organizeMemory(store,{upserts:[memory('用户是医生',3,'我是医生')]}),/直接消息/)
})
test('forgotten facts cannot be relearned from old evidence and a failed change rolls back',t=>{
  const store=fixture(t),id=add(store,'我在三班')
  organizeMemory(store,{upserts:[memory('用户在三班',id,'我在三班')]});store.forget(store.memories()[0].id)
  assert.throws(()=>organizeMemory(store,{upserts:[memory('用户的班级是三班',id,'我在三班')]}),/忘记/)
  const next=add(store,'我在三班');organizeMemory(store,{upserts:[memory('用户在三班',next,'我在三班')]});assert.equal(store.memories().length,1)
  assert.throws(()=>organizeMemory(store,{upserts:[memory('新事实',next,'我在三班')],retire:[{id:999,reason:'obsolete'}]}));assert.equal(store.memories().length,1)
})
test('style observations count each source once, respect disabling and exclude forwarded style',t=>{
  const store=fixture(t)
  for(let i=0;i<3;i++){const id=add(store,'请直接把结果告诉我就行 '+i);const args={style_observations:[{id,tone:'direct'}]};organizeMemory(store,args);organizeMemory(store,args)}
  assert.equal(store.get('style_counts').tone.direct,3);assert.equal(store.get('learned_style').tone,'direct')
  store.set('style_learning',false);organizeMemory(store,{style_observations:[{id:add(store,'请用正式的语气回复我就行'),tone:'formal'}]});assert.equal(store.get('style_counts').tone.formal,undefined)
})
test('idle hook waits for conversation completion, skips pending inbox and runs once per range',async t=>{
  const store=fixture(t),now=Date.parse('2026-10-19T14:00:00+08:00');add(store,'我更喜欢列表',now-600000);store.db.exec("UPDATE inbox SET state='done'");store.set('native_session_id','native')
  const calls=[],runtime={store,model:{async maintain(job){calls.push(job)},async compact(){calls.push('compact')}}},maintenance=new Maintenance(runtime)
  store.set('conversation_finished_at',now-299999);assert.equal(maintenance.next(now),null)
  store.set('conversation_finished_at',now-300000);const job=maintenance.next(now);assert.equal(job.kind,'idle');await maintenance.run(job)
  assert.equal(calls.length,1);assert.equal(maintenance.next(now),null);assert.equal(store.get('memory_reviewed_through'),1)
  add(store,'有个新消息',now-600000);assert.equal(maintenance.next(now),null)
})
test('night hook organizes memory then compacts natively; retry after compaction failure skips repeated memory turn',async t=>{
  const store=fixture(t),now=Date.parse('2026-10-20T03:05:00+08:00');add(store,'我是三班的学生',now-600000);store.db.exec("UPDATE inbox SET state='done'");store.set('native_session_id','native')
  const calls=[];let fail=true
  const maintenance=new Maintenance({store,model:{async maintain(){calls.push('memory')},async compact(){calls.push('compact');if(fail)throw Error('test compact failure')}}})
  const job=maintenance.next(now);assert.equal(job.kind,'night');await maintenance.run(job)
  const saved=store.db.prepare('SELECT * FROM maintenance_jobs').get();assert.equal(saved.phase,'compact');assert.equal(saved.state,'pending')
  fail=false;await maintenance.run(saved);assert.deepEqual(calls,['memory','compact','compact']);assert.equal(maintenance.next(now),null)
})
test('maintenance backlog is reviewed in pages before nightly compaction',t=>{
  const store=fixture(t),now=Date.parse('2026-10-20T03:05:00+08:00');for(let i=0;i<35;i++)add(store,'消息'+i,now-600000)
  store.db.exec("UPDATE inbox SET state='done'");store.set('native_session_id','native');const maintenance=new Maintenance({store})
  const job=maintenance.next(now);assert.equal(job.kind,'idle');assert.equal(job.through_id,30);assert.equal(maintenance.sources(job).length,30)
})
test('Markdown survives the channel and long fenced code is balanced in every chunk',()=>{
  const text='## 待办\n\n- **交表**：[入口](https://example.com)\n\n> 留意时间'
  assert.deepEqual(markdownChunks(text),[text])
  const chunks=markdownChunks('```js\n'+'console.log("你好")\n'.repeat(300)+'```\n\n结束')
  assert.ok(chunks.length>1);assert.ok(chunks.every(s=>s.length<=1400));assert.ok(chunks.every(s=>(s.match(/^```/gm)??[]).length%2===0));assert.match(chunks.at(-1),/结束/)
  assert.ok(markdownChunks('`'.repeat(5000)).every(s=>s.length<=1400))
})


test('daytime maintenance has a cooldown and no-new-message scans are suppressed',t=>{
  const store=fixture(t),now=Date.parse('2026-10-19T14:00:00+08:00');add(store,'新的偏好',now-600000);store.db.exec("UPDATE inbox SET state='done'");store.set('native_session_id','native')
  const maintenance=new Maintenance({store});store.set('maintenance_last_attempt_at',now-599999)
  assert.equal(maintenance.next(now),null);store.set('maintenance_last_attempt_at',now-600000);assert.ok(maintenance.next(now))
})
