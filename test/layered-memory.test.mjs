import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { organizeMemory,memoryState,recallMemory } from '../src/memory.mjs'
import { communicationState,forgetCommunication,resetCommunication } from '../src/communication.mjs'
import { Maintenance } from '../src/maintenance.mjs'

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'life-layered-')),store=new Store(join(dir,'db.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});return store}
function add(store,text){store.ingest('m'+store.db.prepare('SELECT count(*) n FROM inbox').get().n,'owner',text,Date.now()-600000);return store.db.prepare('SELECT max(id) id FROM inbox').get().id}
function insight(id,quote,overrides={}){return {pattern:'办事时用短句催推进',context:'任务执行与结果确认',rationale:'可能想尽快拿到可以行动的结果，而非重复解释',guidance:'先完成动作、给出结果；必要的限制简短说明',basis:'hypothesis',sources:[{id,quote}],...overrides}}

test('layered store exceeds old 100 limit while prompt memory remains bounded and relevant',t=>{
  const store=fixture(t)
  for(let i=0;i<130;i++)store.memory('既有资料 '+i+' '+('背景细节'.repeat(120)))
  const id=add(store,'我的毕业设计在做校园预约系统')
  organizeMemory(store,{upserts:[{body:'毕业设计项目是校园预约系统',layer:'projects',topic:'毕业设计',importance:5,sources:[{id,quote:'我的毕业设计在做校园预约系统'}]}]})
  assert.equal(store.memories().length,131)
  const state=memoryState(store,{query:'毕业设计预约',budget:2000})
  assert.ok(JSON.stringify(state.memories).length<=2002);assert.ok(state.memories.some(m=>m.body.includes('校园预约')));assert.ok(state.memories.length<131)
  assert.ok(state.memory_layers.some(l=>l.layer==='projects'&&l.count===1))
  assert.equal(recallMemory(store,{query:'校园预约',limit:1}).memories[0].topic,'毕业设计')
})
test('expired episodes leave active retrieval but remain in durable storage; retrieved pages do not skip IDs',t=>{
  const store=fixture(t),id=add(store,'这周已经把报名资料交齐了')
  organizeMemory(store,{upserts:[{body:'本周报名资料已交齐',layer:'episodes',expires_at:new Date(Date.now()-1000).toISOString(),sources:[{id,quote:'这周已经把报名资料交齐了'}]}]})
  assert.equal(store.memories().length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memories').get().n,1)
  for(let i=0;i<15;i++)store.memory('测试项目 '+i)
  const page1=recallMemory(store,{limit:5}),page2=recallMemory(store,{after:page1.nextAfter,limit:5})
  assert.equal(new Set([...page1.memories,...page2.memories].map(m=>m.id)).size,10)
  const ranked1=recallMemory(store,{query:'测试项目',limit:5}),ranked2=recallMemory(store,{query:'测试项目',offset:ranked1.nextOffset,limit:5})
  assert.equal(new Set([...ranked1.memories,...ranked2.memories].map(m=>m.id)).size,10)
})
test('repeated language evidence supports a pattern without turning inferred reasons into facts',t=>{
  const store=fixture(t)
  for(let i=0;i<3;i++){const quote='结果直接告诉我就好 '+i,id=add(store,quote),args={communication:[insight(id,quote)]};organizeMemory(store,args);organizeMemory(store,args)}
  const row=communicationState(store)[0];assert.equal(row.status,'supported');assert.equal(row.sources.length,3);assert.equal(row.rationaleStatus,'hypothesis');assert.ok(row.rationaleConfidence<=0.6)
})
test('an explicit preference can be used immediately while its reason remains a hypothesis',t=>{
  const store=fixture(t),quote='不要啰嗦，直接给结果',id=add(store,quote)
  organizeMemory(store,{communication:[insight(id,quote,{pattern_explicit:true})]})
  const row=communicationState(store)[0];assert.equal(row.status,'explicit');assert.equal(row.rationaleStatus,'hypothesis')
  assert.throws(()=>organizeMemory(store,{communication:[insight(id,quote,{basis:'self_report',reason_quote:'直接给结果'})]}),/明确原因/)
})
test('a stated causal reason is preserved separately, and corrections replace the earlier judgment',t=>{
  const store=fixture(t),quote='我想先看结果，因为我正在赶时间',id=add(store,quote)
  organizeMemory(store,{communication:[insight(id,quote,{basis:'self_report',reason_quote:'因为我正在赶时间',rationale:'用户说明当时正在赶时间'})]})
  const first=communicationState(store)[0];assert.equal(first.rationaleStatus,'self_report')
  const correction='学习的时候我希望你详细说明，不用像办事时那么短',next=add(store,correction)
  organizeMemory(store,{communication:[insight(next,correction,{pattern:'学习时需要详细解释',context:'学习指导',rationale:'可能需要理解过程以便独立完成',guidance:'按步骤解释并举例',pattern_explicit:true,replace_ids:[first.id]})]})
  const rows=communicationState(store);assert.equal(rows.length,1);assert.equal(rows[0].rationaleStatus,'hypothesis');assert.match(rows[0].context,/学习/)
})
test('learning switch, forgetting and reset also apply to communication explanations',t=>{
  const store=fixture(t),quote='不要反复问我确认，先把资料看完',id=add(store,quote),args={communication:[insight(id,quote)]}
  store.set('style_learning',false);organizeMemory(store,args);assert.equal(communicationState(store,{all:true}).length,0)
  store.set('style_learning',true);organizeMemory(store,args);forgetCommunication(store,communicationState(store)[0].id)
  assert.throws(()=>organizeMemory(store,args),/已忘记/)
  const newer=add(store,quote);organizeMemory(store,{communication:[insight(newer,quote)]});resetCommunication(store);assert.equal(communicationState(store).length,0)
})
test('upgrade does not replay previously reviewed history and hooks carry only new indices',t=>{
  const store=fixture(t),first=add(store,'帮我检查一下资料'),second=add(store,'我已经发了，你先看一下')
  store.db.prepare("UPDATE inbox SET state='done',result=? WHERE id=?").run(JSON.stringify({reply:'请再发一遍资料'}),first)
  store.db.prepare("UPDATE inbox SET state='done',result=? WHERE id=?").run(JSON.stringify({reply:'好的，我先读取'}),second)
  store.set('native_session_id','native');store.set('memory_reviewed_through',second)
  const maintenance=new Maintenance({store});assert.equal(maintenance.next(),null)
  const next=add(store,'新对话内容');store.db.prepare("UPDATE inbox SET state='done' WHERE id=?").run(next)
  const job=maintenance.next();assert.ok(job);const sources=maintenance.sources(job)
  assert.deepEqual(sources.map(s=>({...s})),[{id:next}])
})
test('invalid communication evidence rolls back memory changes in the same tool call',t=>{
  const store=fixture(t),quote='项目是预约系统',id=add(store,quote)
  assert.throws(()=>organizeMemory(store,{upserts:[{body:'预约系统项目',sources:[{id,quote}]}],communication:[insight(id,'伪造的语气依据')]}),/直接发言/)
  assert.equal(store.memories().length,0)
})
