import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runtime } from '../src/runtime.mjs'
import { nativeOutcome } from '../src/native-agent.mjs'

function nativeHost(){
  const events=[],prompts=[],registered=new Map();let agent,turn=0,fail=false,compacted=0
  const ctx={
    systemPrompt:{section(){return ()=>{}},context(){return ()=>{}},variable(){return ()=>{}}},
    tools:{register(def){registered.set(def.name,def);return ()=>registered.delete(def.name)}},
    workspaceController:{async create({path}){return {workspace:{workspaceId:'workspace',path}}}},
    sessionController:{
      async create({sessionId,workspaceId,cwd}){assert.ok(!(workspaceId&&cwd));agent??={id:sessionId,session:{id:sessionId},status:'idle',cancel(){},async whenIdle(){const pending=events.at(-1);if(pending?.type==='user/message'){events.push({type:'assistant/message',data:{turn,message:{content:[{type:'text',text:'已由原生 Agent 整批处理'}]}}},{type:'turn/end',data:{turn,reason:fail?{kind:'error',error:{message:'native failure'}}:{kind:'completed'}}})}}};return {sessionId}},
      async resolveAgent(){return {agent}},async selectModel(){},async rename(){},
      async inspect(){return {events:structuredClone(events)}},
      async prompt(request){prompts.push(request);turn++;events.push({type:'turn/start',data:{turn}},{type:'user/message',data:{id:request.requestId,source:{kind:'user',rpcId:request.requestId},content:request.content}});return {accepted:true}},
    },
    sessions:{async flush(){}},agentPresets:{serviceFor(){return {async compactNow(){compacted++;return {ok:true}}}}},
  }
  Object.defineProperty(ctx,'llm',{get(){throw Error('Direct LLM calls are forbidden in this test')}})
  return {ctx,events,prompts,registered,get agent(){return agent},fail:value=>{fail=value},get compacted(){return compacted}}
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
