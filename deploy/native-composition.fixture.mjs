import { it,expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime,{createUserMessage} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MockAdapter,toolCallResponse } from '../../agent-loop/tests/mock-adapter.ts'

it('runs yoyo across attention changes through one real native DSH Agent',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-yoyo-')),ctx=new Context()
 let store,social
 try{
  const base=process.env.YOYO_PLUGIN_ROOT
  if(!base)throw Error('YOYO_PLUGIN_ROOT required')
  const {Store}=await import(pathToFileURL(join(base,'src/store.mjs')).href)
  const {SocialAgent}=await import(pathToFileURL(join(base,'src/social-agent.mjs')).href)
  const {NativeAgent,nativeOutcome}=await import(pathToFileURL(join(base,'src/native-agent.mjs')).href)
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry,TokenMeter])await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop,{agents:[]})
  await ctx.plugin(BasicCompactionEngine,{auto:false})
  await ctx.plugin(ToolResultPruner)
  ctx.agentPresets={serviceFor(){return ctx.compaction}}
  store=new Store(join(root,'data.sqlite'));store.set('owner','private-owner');store.set('yoyo_legacy_labelled',true);store.set('yoyo_settings',{observeOnly:false,dailySteps:30})
  const native=await ctx.agentLoop.create(SessionId('one-yoyo'),{provider:'mock',model:'mock'})
  const runtime={store,workspace:root,abort:new AbortController(),model:null}
  ctx.sessionController={async inspect(){return {events:native.session.snapshotEvents()}},async prompt(request){native.followup(createUserMessage({content:request.content,source:{kind:'user',rpcId:request.requestId}}));return {accepted:true}}}
  runtime.model={sessionId:native.id,async ensure(){return native},outcome:nativeOutcome,receipt:NativeAgent.prototype.receipt.bind({ctx,store})}
  social=new SocialAgent(runtime,ctx,{enabled:true})
  const owner=social.ownerTarget();social.activeView=social.data.open(owner.handle)
  native.session.append('user/message',createUserMessage({content:[{type:'text',text:'PRIVATE_CANARY_92db'}],source:{kind:'user'}}),{surfaceOp:'append'})
  const target=social.data.discover({platform:'qq',account:'10001',kind:'private',peer:'22222',label:'网友'})
  social.data.approve(target.handle,true);social.data.ingest({target:target.handle,sender:'22222',externalId:'a',text:'hello friend'})
  const adapter=new MockAdapter([toolCallResponse('open','yoyo_open',{target:target.handle}),toolCallResponse('read','yoyo_read',{}),toolCallResponse('send','yoyo_send',{text:'hello back'}),toolCallResponse('sleep','yoyo_sleep',{until:null,reason:'先休息'})])
  ctx.llm.registerAdapter(['mock'],adapter)
  store.set('yoyo_next_focus','public')
  await social.tick();await social.tick()
  expect(adapter.requests).toHaveLength(4)
  expect(JSON.stringify(adapter.requests)).not.toContain('PRIVATE_CANARY_92db')
  expect(JSON.stringify(adapter.requests.at(-1))).toContain('hello friend')
  expect(social.data.snapshot().outbox).toMatchObject([{state:'queued'}])
  expect(social.data.db.prepare("SELECT count(*) n FROM yoyo_turns WHERE state='done'").get().n).toBe(2)
  expect(native.id).toBe('one-yoyo')
  expect(native.session.snapshotEvents().filter(e=>e.type==='request/view')).toHaveLength(2)
 }finally{social?.stop();await ctx.fiber.dispose();store?.close();rmSync(root,{recursive:true,force:true})}
})
