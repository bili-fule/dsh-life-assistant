import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runtime } from '../src/runtime.mjs'
import { nativeOutcome } from '../src/native-agent.mjs'
import { deliverOne } from '../src/assistant.mjs'

function nativeHost(){
  const events=[],prompts=[],registered=new Map();let agent,turn=0,fail=false,compacted=0,onTurn=null
  const ctx={
    systemPrompt:{section(){return ()=>{}},context(){return ()=>{}},variable(){return ()=>{}}},
    tools:{register(def){registered.set(def.name,def);return ()=>registered.delete(def.name)}},
    workspaceController:{async create({path}){return {workspace:{workspaceId:'workspace',path}}}},
    sessionController:{
      async create({sessionId,workspaceId,cwd}){assert.ok(!(workspaceId&&cwd));agent??={id:sessionId,session:{id:sessionId},status:'idle',cancel(){},async whenIdle(){const pending=events.at(-1);if(pending?.type==='user/message'){if(onTurn)await onTurn(agent);events.push({type:'assistant/message',data:{turn,message:{content:[{type:'text',text:'已由原生 Agent 整批处理'}]}}},{type:'turn/end',data:{turn,reason:fail?{kind:'error',error:{message:'native failure'}}:{kind:'completed'}}})}}};return {sessionId}},
      async resolveAgent(){return {agent}},async selectModel(){},async rename(){},
      async inspect(){return {events:structuredClone(events)}},
      async prompt(request){prompts.push(request);turn++;events.push({type:'turn/start',data:{turn}},{type:'user/message',data:{id:request.requestId,source:{kind:'user',rpcId:request.requestId},content:request.content}});return {accepted:true}},
    },
    sessions:{async flush(){}},agentPresets:{serviceFor(){return {async compactNow(){compacted++;return {ok:true}}}}},
  }
  Object.defineProperty(ctx,'llm',{get(){throw Error('Direct LLM calls are forbidden in this test')}})
  return {ctx,events,prompts,registered,onTurn:fn=>{onTurn=fn},get agent(){return agent},fail:value=>{fail=value},get compacted(){return compacted}}
}
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'life-native-')),host=nativeHost(),runtime=new Runtime({stateDir:dir,nativeContext:host.ctx});t.after(async()=>{await runtime.stop();rmSync(dir,{recursive:true,force:true})});return {dir,host,runtime}}
function options(id=1){return {rowId:id,batchIds:[id],directTexts:['请在明天交表']}}

test('mixed messages are submitted once through native SessionController and one native turn',async t=>{
  const {runtime,host}=fixture(t);runtime.running=true
  for(let i=0;i<3;i++)runtime.store.ingest('m'+i,'owner',['群通知：交表','截止改为周五','我是三班'][i],Date.now()-20000+i)
  await runtime.tick()
  assert.equal(host.prompts.length,1);const text=host.prompts[0].content[0].text
  assert.match(text,/群通知：交表/);assert.match(text,/截止改为周五/);assert.match(text,/我是三班/)
  assert.equal(runtime.store.snapshot().outbox.length,1);assert.ok(runtime.store.snapshot().inbox.every(r=>r.state==='done'))
  assert.ok(host.events.some(e=>e.type==='turn/end'));assert.equal(runtime.store.get('native_session_id'),host.prompts[0].sessionId)
})
test('recovery reads the native receipt and never resubmits an already completed prompt',async t=>{
  const {runtime,host}=fixture(t);runtime.store.ingest('m','owner','请在明天交表')
  const a=await runtime.model.analyze('请在明天交表',runtime.store,Date.now(),options())
  const b=await runtime.model.analyze('请在明天交表',runtime.store,Date.now(),options())
  assert.equal(host.prompts.length,1);assert.equal(a.reply,b.reply)
})
test('failed native turns are not resubmitted by automatic retries; explicit retry gets a new receipt',async t=>{
  const {runtime,host}=fixture(t);runtime.store.ingest('m','owner','请在明天交表');host.fail(true)
  for(let i=0;i<3;i++)await assert.rejects(()=>runtime.model.analyze('请在明天交表',runtime.store,Date.now(),options()),/native failure/)
  assert.equal(host.prompts.length,1)
  runtime.store.db.exec("UPDATE inbox SET state='failed'");runtime.batcher.retry(1);host.fail(false)
  await runtime.model.analyze('请在明天交表',runtime.store,Date.now(),options());assert.equal(host.prompts.length,2);assert.notEqual(host.prompts[0].requestId,host.prompts[1].requestId)
})
test('task and memory operations are registered as native tools and retain original evidence',async t=>{
  const {runtime,host}=fixture(t);runtime.store.ingest('m','owner','请在明天交表')
  await runtime.model.analyze('请在明天交表',runtime.store,Date.now(),options())
  const definition=host.registered.get('life_record'),exec={agent:host.agent,callId:'native-call-1',signal:runtime.abort.signal}
  const args={tasks:[{title:'交表',status:'confirm',reason:'日期需确认',evidence:'请在明天交表'}]}
  const first=await definition.execute(args,exec),second=await definition.execute(args,exec)
  assert.deepEqual(second,first);assert.equal(runtime.store.tasks().length,1)
  await assert.rejects(()=>definition.execute({tasks:[{...args.tasks[0],evidence:'伪造的证据'}]},{...exec,callId:'bad-evidence'}),/原文依据/)
  assert.ok(host.registered.has('life_read_file'));assert.ok(host.registered.has('life_send_file'));assert.ok(!host.registered.has('shell'))
})
test('manual compaction delegates to native preset service and retains archived originals',async t=>{
  const {runtime,host}=fixture(t);runtime.store.ingest('m','owner','归档原文')
  await runtime.model.compact();assert.equal(host.compacted,1);assert.equal(runtime.store.search('归档原文').length,1)
})

test('a native UI turn can queue Markdown to the bound WeChat without an inbox message; retries reuse one queue entry',async t=>{
  const {runtime,host}=fixture(t);await runtime.model.ensure()
  runtime.store.set('owner','bound-owner');runtime.store.set('wechat',{token:'test-token'})
  host.events.push({type:'turn/start',data:{turn:1}},{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'把结果发到我的微信'}]}})
  const tool=host.registered.get('life_send_message'),exec={agent:host.agent,callId:'ui-send',signal:runtime.abort.signal}
  assert.deepEqual(Object.keys(tool.parameters.properties),['text']);assert.equal(tool.parameters.additionalProperties,false)
  const result=await tool.execute({text:'**完成**\n\n[结果](https://example.com)'},exec)
  assert.equal(result.queued,true);assert.deepEqual(await tool.execute({text:'**完成**\n\n[结果](https://example.com)'},exec),result)
  assert.equal(runtime.store.snapshot().inbox.length,0)
  const rows=runtime.store.db.prepare('SELECT * FROM outbox').all();assert.equal(rows.length,1);assert.match(rows[0].body,/\*\*完成\*\*/)
  runtime.store.set('quiet',{start:0,end:23})
  const now=new Date('2026-10-19T01:00:00Z').getTime()
  assert.equal(await deliverOne(runtime.store,async()=>{throw Error('platform rejected')},now),false)
  assert.equal(runtime.store.db.prepare('SELECT state FROM outbox').get().state,'pending')
  const due=runtime.store.db.prepare('SELECT next_at FROM outbox').get().next_at
  assert.equal(await deliverOne(runtime.store,async text=>assert.equal(text,rows[0].body),due),true)
  assert.equal(runtime.store.db.prepare('SELECT state FROM outbox').get().state,'sent')
})

test('message sending rejects unbound accounts, invalid content and unrelated sessions',async t=>{
  const {runtime,host}=fixture(t);await runtime.model.ensure()
  const tool=host.registered.get('life_send_message'),exec={agent:host.agent,callId:'unbound',signal:runtime.abort.signal}
  await assert.rejects(()=>tool.execute({text:'hello'},exec),/先绑定/)
  runtime.store.set('owner','bound-owner');runtime.store.set('wechat',{token:'test-token'})
  for(const [i,text] of [null,'   ','x'.repeat(20001)].entries())await assert.rejects(()=>tool.execute({text},{...exec,callId:'invalid-'+i}),/非空文本/)
  await assert.rejects(()=>tool.execute({text:'hello'},{...exec,agent:{id:'other-session'}}),/绑定用户的会话/)
  assert.equal(runtime.store.snapshot().outbox.length,0)
})
test('a provider reusing call IDs on a later native turn cannot receive stale state',async t=>{
  const {runtime,host}=fixture(t);runtime.store.ingest('a','owner','第一次消息');await runtime.model.analyze('第一次消息',runtime.store,Date.now(),options())
  const tool=host.registered.get('life_state'),exec={agent:host.agent,callId:'reused-id',signal:runtime.abort.signal}
  const first=await tool.execute({},exec);runtime.store.set('persona','新的用户人设')
  runtime.store.ingest('b','owner','第二次消息');await runtime.model.analyze('第二次消息',runtime.store,Date.now(),options(2))
  const next=await tool.execute({},exec);assert.notEqual(next.persona,first.persona);assert.equal(next.persona,'新的用户人设')
})
test('a later native UI turn cannot overwrite the WeChat request result',()=>{
  const events=[{type:'turn/start',data:{turn:1}},{type:'user/message',data:{source:{rpcId:'wechat'}}},{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'微信回复'}]}}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},{type:'turn/start',data:{turn:2}},{type:'user/message',data:{source:{rpcId:'ui'}}},{type:'assistant/message',data:{turn:2,message:{content:[{type:'text',text:'界面回复'}]}}}]
  assert.equal(nativeOutcome(events,'wechat').reply,'微信回复')
})
test('missing native services fail clearly without falling back to a handwritten loop',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'life-no-native-')),runtime=new Runtime({stateDir:dir});t.after(async()=>{await runtime.stop();rmSync(dir,{recursive:true,force:true})})
  await assert.rejects(()=>runtime.model.analyze('hello',runtime.store,Date.now(),options()),/不会回退/)
})


test('native wait joins later messages atomically, keeps evidence, and sends one final reply',async t=>{
  const {runtime,host}=fixture(t);runtime.running=true;runtime.config.agentWaitMs=1
  runtime.store.ingest('first','owner','我还有资料，等一下',Date.now()-6000)
  host.onTurn(async agent=>{
    runtime.store.ingest('late','owner','我在三班，偏好直接说结果',Date.now())
    const tool=host.registered.get('life_wait'),exec={agent,callId:'wait-1',signal:runtime.abort.signal}
    const result=await tool.execute({reason:'用户表示还有资料'},exec)
    assert.equal(result.received,1);assert.match(result.text,/偏好直接说结果/)
    const cached=await tool.execute({reason:'用户表示还有资料'},exec);assert.deepEqual(cached,result)
    const record=host.registered.get('life_memory')
    await record.execute({upserts:[{body:'用户在三班',sources:[{id:2,quote:'我在三班'}]}]},{...exec,callId:'remember-late'})
  })
  await runtime.tick()
  assert.equal(host.prompts.length,1);assert.equal(runtime.store.snapshot().outbox.length,1)
  assert.ok(runtime.store.snapshot().inbox.every(row=>row.state==='done'));assert.equal(runtime.store.memories().length,1)
  assert.equal(runtime.store.inputContext(1).nativeRequest.waits,1)
})
test('background native turns leave a trace but do not enqueue a WeChat response or execute ordinary tools',async t=>{
  const {runtime,host}=fixture(t);runtime.store.ingest('m','owner','我喜欢简短回复');runtime.store.db.exec("UPDATE inbox SET state='done'")
  host.onTurn(async agent=>{
    await assert.rejects(()=>host.registered.get('life_send_file').execute({path:'test.md'},{agent,callId:'no-send',signal:runtime.abort.signal}),/后台整理/)
    await assert.rejects(()=>host.registered.get('life_send_message').execute({text:'不应发送'},{agent,callId:'no-text-send',signal:runtime.abort.signal}),/后台整理/)
    await host.registered.get('life_memory').execute({upserts:[{body:'用户偏好简短回复',sources:[{id:1,quote:'我喜欢简短回复'}]}]},{agent,callId:'memory',signal:runtime.abort.signal})
  })
  const job={kind:'idle',through_id:1,request_id:'maintenance:test:1'}
  await runtime.model.maintain(job,[{id:1,direct_text:'我喜欢简短回复'}]);await runtime.model.maintain(job,[])
  assert.equal(host.prompts.length,1);assert.equal(runtime.store.snapshot().outbox.length,0);assert.equal(runtime.store.memories().length,1);assert.equal(runtime.model.maintenanceJob,null);assert.ok(!host.prompts[0].content[0].text.includes('我喜欢简短回复'));assert.ok(host.prompts[0].content[0].text.includes('直接使用你已有的原生会话上下文'))
})
test('native waits are bounded and a new round with no supplement leaves messages available',async t=>{
  const {runtime,host}=fixture(t);runtime.running=true;runtime.config.agentWaitMs=1
  runtime.store.ingest('first','owner','等我补充资料',Date.now()-6000)
  host.onTurn(async agent=>{
    const tool=host.registered.get('life_wait')
    for(let i=0;i<4;i++){
      const result=await tool.execute({reason:'等待补充资料'},{agent,callId:'wait-'+i,signal:runtime.abort.signal})
      assert.equal(result.received,0);assert.equal(!!result.limitReached,i===3)
    }
  })
  await runtime.tick();assert.equal(runtime.store.inputContext(1).nativeRequest.waits,3)
  assert.equal(runtime.store.snapshot().outbox.length,1)
})


test('context inspection returns lossless JSON using the host token meter',async t=>{
  const {runtime,host}=fixture(t);host.ctx.get=name=>name==='tokenMeter'?{measure:()=>({totalTokens:263050,baseline:{kind:'usage'}})}:undefined
  await runtime.model.ensure()
  const result=await host.registered.get('life_context').execute({},{agent:host.agent,callId:'context',signal:runtime.abort.signal})
  assert.equal(result.measuredTokens,263050);assert.equal(result.declaredModelWindow,1000000);assert.deepEqual(result,JSON.parse(JSON.stringify(result)))
})


test('WeChat ledger stays in private native state even when separate QQ autonomy is enabled',async t=>{
 const {runtime,host}=fixture(t);await runtime.model.ensure()
 runtime.autonomy.enabled=true
 runtime.ledger.insert({day:'2026-10-20',kind:'income',amount:'12',description:'PRIVATE_LEDGER_CANARY'},'test',{})
 assert.equal(runtime.model.state().ledger.months[0].income,1200)
 assert.equal(JSON.stringify(runtime.autonomy.state()).includes('PRIVATE_LEDGER_CANARY'),false)
 const tool=host.registered.get('life_ledger_query')
 await assert.rejects(()=>tool.execute({},{agent:{id:'qq-agent'},callId:'private-ledger',signal:runtime.abort.signal}),/绑定用户/)
 runtime.model.maintenanceJob={through_id:10}
 await assert.rejects(()=>host.registered.get('life_ledger_record').execute({},{agent:host.agent,callId:'maintenance-write',signal:runtime.abort.signal}),/后台整理/)
})
