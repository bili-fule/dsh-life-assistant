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
import { MockAdapter,toolCallResponse,textResponse } from '../../agent-loop/tests/mock-adapter.ts'

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
  const adapter=new MockAdapter([toolCallResponse('inbox','yoyo_inbox',{}),toolCallResponse('open','yoyo_open',{target:target.handle}),toolCallResponse('read','yoyo_read',{}),toolCallResponse('send','yoyo_send',{text:'hello back'}),toolCallResponse('sleep','yoyo_sleep',{until:null,reason:'先休息'})])
  ctx.llm.registerAdapter(['mock'],adapter)
  store.set('yoyo_next_focus','public')
  await social.tick();await social.tick()
  expect(adapter.requests).toHaveLength(5)
  expect(JSON.stringify(adapter.requests)).not.toContain('PRIVATE_CANARY_92db')
  expect(JSON.stringify(adapter.requests.at(-1))).toContain('hello friend')
  expect(social.data.snapshot().outbox).toMatchObject([{state:'queued'}])
  expect(social.data.db.prepare("SELECT count(*) n FROM yoyo_turns WHERE state='done'").get().n).toBe(2)
  expect(native.id).toBe('one-yoyo')
  expect(native.session.snapshotEvents().filter(e=>e.type==='request/view')).toHaveLength(2)
 }finally{social?.stop();await ctx.fiber.dispose();store?.close();rmSync(root,{recursive:true,force:true})}
})


it('keeps QQ in its own real native agent and denies outbound actions during memory review',async()=>{
 const root=mkdtempSync(join(tmpdir(),'separate-native-yoyo-')),ctx=new Context(),agents=new Map()
 let store,social
 try{
  const base=process.env.YOYO_PLUGIN_ROOT
  const {Store}=await import(pathToFileURL(join(base,'src/store.mjs')).href)
  const {SocialAgent}=await import(pathToFileURL(join(base,'src/social-agent.mjs')).href)
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry,TokenMeter])await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(BasicCompactionEngine,{auto:false});await ctx.plugin(ToolResultPruner)
  ctx.agentPresets={serviceFor(){return ctx.compaction}}
  const privateAgent=await ctx.agentLoop.create(SessionId('private-native'),{provider:'mock',model:'mock'})
  privateAgent.session.append('user/message',createUserMessage({content:[{type:'text',text:'PRIVATE_OWNER_CANARY_a7d0'}],source:{kind:'user'}}),{surfaceOp:'append'})
  ctx.workspaceController={async create(){return {workspace:{workspaceId:'social-workspace'}}}}
  ctx.sessionController={
   async create({sessionId}){if(!agents.has(sessionId))agents.set(sessionId,await ctx.agentLoop.create(SessionId(sessionId),{provider:'mock',model:'mock'}))},
   async selectModel(){},async rename(){},async resolveAgent(id){return {agent:agents.get(id)}},
   async inspect(id){return {events:agents.get(id).session.snapshotEvents()}},
   async prompt(r){agents.get(r.sessionId).followup(createUserMessage({content:r.content,source:{kind:'user',rpcId:r.requestId}}));return {accepted:true}}
  }
  store=new Store(join(root,'private.sqlite'));store.set('owner','private-owner')
  social=new SocialAgent({store,workspace:root,config:{provider:'mock',model:'mock'},abort:new AbortController(),model:{sessionId:privateAgent.id,ensure(){throw Error('must not use private agent')}}},ctx,{enabled:true,separateSession:true})
  social.store.set('yoyo_settings',{observeOnly:false,dailySteps:30})
  const target=social.data.discover({platform:'qq',account:'10001',kind:'private',peer:'22222'})
  social.data.approve(target.handle,true);const message=social.data.ingest({target:target.handle,sender:'22222',externalId:'a',text:'hello friend',receivedAt:Date.now()-300000})
  const adapter=new MockAdapter([toolCallResponse('read','yoyo_read',{}),toolCallResponse('send','yoyo_send',{text:'hello back'}),toolCallResponse('sleep','yoyo_sleep',{until:null,reason:'等消息'}),toolCallResponse('blocked-send','yoyo_send',{text:'MUST_NOT_SEND'}),toolCallResponse('memory','yoyo_memory',{kind:'episodes',body:'打过招呼',sources:[{id:message.id,quote:'hello friend'}],confidence:'observed'}),textResponse('已完成后台整理，无对外动作。')])
  ctx.llm.registerAdapter(['mock'],adapter);social.store.set('yoyo_next_focus',target.handle)
  await social.tick();social.memoryMaintenance.config.idleMs=0;await social.tick()
  expect(social.sessionId).not.toBe(privateAgent.id);expect(JSON.stringify(adapter.requests)).not.toContain('PRIVATE_OWNER_CANARY_a7d0')
  expect(social.memoryMaintenance.status().jobs).toMatchObject([{state:'done'}])
  expect(social.data.snapshot().outbox).toHaveLength(1)
  expect(social.data.recall(social.activeView.id)).toMatchObject([{body:'打过招呼'}])
  expect(adapter.requests.at(-1).toolHistory.tools.map(t=>t.name)).not.toContain('yoyo_send')
 }finally{await ctx.fiber.dispose();social?.stop();store?.close();rmSync(root,{recursive:true,force:true})}
})


it('persists a self-chosen concern and resumes it once through the native loop without new chat',async()=>{
 const root=mkdtempSync(join(tmpdir(),'motivated-native-yoyo-')),ctx=new Context()
 let store,social
 try{
  const base=process.env.YOYO_PLUGIN_ROOT
  const {Store}=await import(pathToFileURL(join(base,'src/store.mjs')).href)
  const {SocialAgent}=await import(pathToFileURL(join(base,'src/social-agent.mjs')).href)
  const {NativeAgent}=await import(pathToFileURL(join(base,'src/native-agent.mjs')).href)
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry,TokenMeter])await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(BasicCompactionEngine,{auto:false});await ctx.plugin(ToolResultPruner)
  ctx.agentPresets={serviceFor(){return ctx.compaction}}
  store=new Store(join(root,'data.sqlite'));store.set('yoyo_legacy_labelled',true);store.set('yoyo_settings',{dailySteps:30})
  const native=await ctx.agentLoop.create(SessionId('motivated-yoyo'),{provider:'mock',model:'mock'})
  ctx.sessionController={async inspect(){return {events:native.session.snapshotEvents()}},async prompt(r){native.followup(createUserMessage({content:r.content,source:{kind:'user',rpcId:r.requestId}}));return {accepted:true}}}
  const runtime={store,workspace:root,abort:new AbortController(),model:{sessionId:native.id,async ensure(){return native},receipt:NativeAgent.prototype.receipt.bind({ctx,store})}}
  social=new SocialAgent(runtime,ctx,{enabled:true})
  const adapter=new MockAdapter([
   toolCallResponse('concern','yoyo_concern',{title:'understand a question',why:'I remain curious',origin:'earlier experience',next:'compare possible explanations',doneWhen:'one tested explanation',stopWhen:'no useful evidence'}),
   toolCallResponse('pause','yoyo_sleep',{until:null,reason:'wait for a useful moment'}),
   toolCallResponse('feedback','yoyo_feedback',{id:1,outcome:'no new evidence; stop for now',decision:'abandon'}),
   toolCallResponse('abandon','yoyo_concern',{id:1,state:'abandoned'}),
   toolCallResponse('rest','yoyo_sleep',{until:null,reason:'no worthwhile next action'})])
  ctx.llm.registerAdapter(['mock'],adapter);store.set('yoyo_next_focus','public')
  await social.tick()
  social.data.db.prepare("UPDATE yoyo_concerns SET body=json_set(body,'$.reviewAt',?) WHERE id=1").run(Date.now()-1)
  await social.tick();await social.tick()
  expect(adapter.requests).toHaveLength(5)
  expect(JSON.stringify(adapter.requests)).toContain('concern_review_due')
  expect(JSON.stringify(adapter.requests)).not.toContain('[调度事件]')
  expect(social.data.concerns(social.activeView.id)[0].state).toBe('abandoned')
  expect(social.data.concernFeedbacks(social.activeView.id)[0].evidence).toBe('self_report')
  expect(social.data.snapshot().outbox).toHaveLength(0)
 }finally{social?.stop();await ctx.fiber.dispose();store?.close();rmSync(root,{recursive:true,force:true})}
})


it('indexes finalized native browser outcomes for verified procedural memory',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-browser-evidence-')),ctx=new Context()
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
  social.config.publicBrowser=true
  const browserName='mcp__playwright-mcp__browser_snapshot'
  ctx.tools.register({name:browserName,description:'Test native browser result',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{title:{type:'string'}},required:['title']},render:(_,value)=>[{type:'text',text:'Page Title: '+value.title}]},async execute(){return {title:'Native verified page'}}})
  const adapter=new MockAdapter([
   toolCallResponse('native-dom',browserName,{}),
   toolCallResponse('evidence','yoyo_evidence',{}),
   ()=>{const proof=social.data.evidence(social.activeView.id)[0];expect(proof.name).toBe(browserName);return toolCallResponse('remember-native','yoyo_memory',{kind:'procedures',body:'原生浏览器实际返回页面标题',sources:[{receipt:proof.receipt,quote:'Native verified page'}]})},
   toolCallResponse('rest','yoyo_sleep',{until:null,reason:'verified'})])
  ctx.llm.registerAdapter(['mock'],adapter);store.set('yoyo_next_focus','public')
  await social.tick()
  expect(social.data.recall(social.activeView.id)).toMatchObject([{kind:'procedures',body:'原生浏览器实际返回页面标题'}])
  expect(social.data.evidence(social.activeView.id)).toHaveLength(1)
 }finally{social?.stop();await ctx.fiber.dispose();store?.close();rmSync(root,{recursive:true,force:true})}
})
