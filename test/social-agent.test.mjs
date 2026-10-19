import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialAgent } from '../src/social-agent.mjs'

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'yoyo-agent-')),store=new Store(join(root,'data.sqlite')),hooks=new Map(),tools=new Map(),prompts=[]
  const ctx={on(name,fn){hooks.set(name,fn);return ()=>hooks.delete(name)},systemPrompt:{section(){return ()=>{}}},tools:{register(tool){tools.set(tool.name,tool);return ()=>tools.delete(tool.name)}},sessions:{requestViewVersion:1},tokenMeter:{requestViewVersion:1}}
  const runtime={store,abort:new AbortController(),workspace:root,model:{sessionId:'one-agent',async receipt(name,args,exec,body){return body('call:'+exec.callId)}}}
  const agent=new SocialAgent(runtime,ctx,{enabled:true})
  t.after(()=>{agent.stop();assert.equal(hooks.size,0);assert.equal(tools.size,0);store.close();rmSync(root,{recursive:true,force:true})})
  const target=(peer)=>{const t=agent.data.discover({platform:'qq',account:'1000',kind:'private',peer});return agent.data.approve(t.handle,true)}
  const exec={agent:{id:'one-agent'},signal:runtime.abort.signal,callId:'1',concludeTurn(){prompts.push('concluded')}}
  return {agent,store,ctx,hooks,tools,target,exec,prompts,runtime}
}

test('social native assembly filters private instructions, contexts and tool schemas',async t=>{
  const {agent,hooks,target}=fixture(t);agent.activeView=agent.data.open(target('123').handle)
  const assembly={sections:[{name:'harness:identity',text:'DSH'},{name:'yoyo:agency',text:'agency'},{name:'owner:instructions',text:'PRIVATE_CANARY'}],contexts:[{name:'life-assistant:state',text:'{{life_assistant_state}}'},{name:'private-files',text:'PRIVATE_CANARY'}],variables:{ownerSecret:'PRIVATE_CANARY'},tools:[{name:'yoyo_read'},{name:'shell'},{name:'life_send_file'}]}
  const safe=await hooks.get('system-prompt/assemble')(assembly,{agent:{id:'one-agent'}},async()=>assembly)
  assert.equal(JSON.stringify(safe).includes('PRIVATE_CANARY'),false)
  assert.deepEqual(safe.tools.map(t=>t.name),['yoyo_read'])
  await assert.rejects(()=>hooks.get('tools/pre-execute')({agent:{id:'one-agent'},name:'shell'},async()=>({})),/未获/)
})

test('opening another window concludes a native turn and defers its request view',async t=>{
  const {agent,store,tools,target,exec,prompts}=fixture(t),a=target('123'),b=target('456')
  agent.activeView=agent.data.open(a.handle)
  await tools.get('yoyo_open').execute({target:b.handle},exec)
  assert.equal(store.get('yoyo_next_focus'),b.handle)
  assert.equal(agent.activeView.focus,a.handle)
  assert.deepEqual(prompts,['concluded'])
})

test('observation does not queue messages and current permissions block cross-window file access',async t=>{
  const {agent,tools,target,exec,store}=fixture(t),a=target('123'),b=target('456')
  const av=agent.data.open(a.handle),bv=agent.data.open(b.handle);agent.activeView=av
  assert.equal((await tools.get('yoyo_send').execute({text:'hello'},exec)).observation,true)
  assert.equal(agent.data.snapshot().outbox.length,0)
  store.set('yoyo_settings',{observeOnly:false})
  await tools.get('yoyo_send').execute({text:'hello'},exec)
  assert.equal(agent.data.snapshot().outbox.length,1)
  agent.data.db.prepare('INSERT INTO yoyo_assets VALUES(?,?,?,?,?)').run('private-file','secret.txt',JSON.stringify(av.scopes),'secret.txt',Date.now())
  agent.activeView=bv
  await assert.rejects(()=>tools.get('yoyo_file').execute({id:'private-file'},exec),/资料范围/)
})

test('revoked views fail at actual native execution even if a schema was previously shown',async t=>{
  const {agent,hooks,target}=fixture(t),a=target('123');agent.activeView=agent.data.open(a.handle)
  agent.data.approve(a.handle,false);let executed=false
  await assert.rejects(()=>hooks.get('tools/pre-execute')({agent:{id:'one-agent'},name:'yoyo_read'},async()=>{executed=true}),/授权/)
  assert.equal(executed,false)
})
