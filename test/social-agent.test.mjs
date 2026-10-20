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

test('isolated native browser tools are available only in a pure public view and never during memory maintenance',async t=>{
 const {agent,hooks,target}=fixture(t),a=target('123'),name='mcp__playwright-mcp__browser_navigate'
 agent.config.publicBrowser=true;agent.activeView=agent.data.publicView()
 assert.equal(agent.toolsAllowed().has(name),true)
 assert.equal(await hooks.get('tools/pre-execute')({agent:{id:'one-agent'},name},async()=>42),42)
 agent.activeView=agent.data.open(a.handle)
 assert.equal(agent.toolsAllowed().has(name),false)
 await assert.rejects(()=>hooks.get('tools/pre-execute')({agent:{id:'one-agent'},name},async()=>{throw Error('must not execute')}),/未获/)
 agent.activeView=agent.data.planningView();assert.equal(agent.toolsAllowed().has(name),false)
 agent.activeView=agent.data.publicView();agent.maintenanceJob={after:0,through:10}
 assert.equal(agent.toolsAllowed().has(name),false)
})

test('native browser outcomes enter scoped evidence without image bytes or fabricated success',t=>{
 const {agent,hooks,target}=fixture(t),a=target('123'),name='mcp__playwright-mcp__browser_snapshot'
 agent.activeView=agent.data.publicView()
 const exec={agent:{id:'one-agent',session:{snapshotEvents(){return [{type:'turn/start',data:{turn:7}}]}}},callId:'browser-call',name}
 hooks.get('tools/result')(exec,{isError:false,content:[{type:'text',text:'Page Title: Verified Page\nSecond line'},{type:'image',data:'MUST_NOT_STORE_BASE64'}]})
 const e=agent.data.evidence(agent.activeView.id)[0]
 assert.match(e.receipt,/native-browser:one-agent:7:browser-call/)
 assert.equal(e.text.includes('MUST_NOT_STORE_BASE64'),false)
 agent.data.remember(agent.activeView.id,{kind:'procedures',body:'页面读取返回实际标题',sources:[{receipt:e.receipt,quote:'Verified Page\nSecond line'}]})
 agent.activeView=agent.data.open(a.handle)
 hooks.get('tools/result')({...exec,callId:'private-synthetic'},{isError:true,content:[{type:'text',text:'PRIVATE_ERROR_CANARY'}]})
 agent.activeView=agent.data.publicView()
 assert.equal(JSON.stringify(agent.data.evidence(agent.activeView.id)).includes('PRIVATE_ERROR_CANARY'),false)
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


test('separate social storage cannot discover the WeChat owner or private memories',t=>{
 const root=mkdtempSync(join(tmpdir(),'separate-yoyo-')),store=new Store(join(root,'private.sqlite'))
 store.set('owner','PRIVATE_OWNER');store.set('persona','PRIVATE_PERSONA');store.set('native_session_id','private-session')
 const social=new SocialAgent({store,workspace:root,model:{sessionId:'private-session'}},null,{separateSession:true})
 t.after(()=>{social.stop();store.close();rmSync(root,{recursive:true,force:true})})
 assert.equal(social.ownerTarget(),null);assert.equal(social.store.get('owner'),null);assert.equal(social.store.get('persona'),null)
 social.store.set('social_session_id','social-session');assert.equal(social.sessionId,'social-session');assert.equal(store.get('native_session_id'),'private-session')
 assert.notEqual(social.runtime.workspace,root)
})

test('already alerted unread messages do not repeatedly wake the social agent',t=>{
 const {agent,store,target}=fixture(t),a=target('123'),now=Date.now()
 store.set('yoyo_started',true);store.set('yoyo_settings',{dailySteps:20})
 agent.data.ingest({target:a.handle,sender:'123',externalId:'first',text:'hello',receivedAt:now-300000})
 assert.equal(agent.choose(now),a.handle)
 agent.data.acknowledgeAttention(agent.data.attention(now+300000,5000))
 assert.equal(agent.choose(now+300000),null)
 agent.data.ingest({target:a.handle,sender:'123',externalId:'second',text:'new message',receivedAt:now})
 assert.equal(agent.choose(now+300000),a.handle)
})


test('separate social agent creates and reuses its own native session and workspace',async t=>{
 const root=mkdtempSync(join(tmpdir(),'separate-session-')),store=new Store(join(root,'private.sqlite')),created=[]
 const social=new SocialAgent({store,workspace:root,config:{provider:'mock',model:'mock'},model:{sessionId:'private-session',ensure(){throw Error('must not use private agent')}}},null,{separateSession:true})
 t.after(()=>{social.stop();store.close();rmSync(root,{recursive:true,force:true})})
 social.ctx={workspaceController:{async create({path}){assert.equal(path,join(root,'qq-social'));return {workspace:{workspaceId:'social-workspace'}}}},sessionController:{async create(args){created.push(args)},async selectModel(){},async rename(){},async resolveAgent(id){return {agent:{id}}}}}
 const first=await social.ensureAgent(),second=await social.ensureAgent()
 assert.equal(first.id,second.id);assert.notEqual(first.id,'private-session');assert.equal(created[0].workspaceId,'social-workspace')
})


test('new private messages wake a sleeping agent after the five-second batch window',t=>{
 const {agent,store,target}=fixture(t),a=target('123'),now=Date.now()
 agent.activeView=agent.data.open(a.handle)
 agent.data.saveActivity(agent.activeView.id,{state:'sleeping',description:'等新消息',wakeAt:null})
 store.set('yoyo_started',true);store.set('yoyo_last_wake',now);store.set('yoyo_settings',{dailySteps:100})
 agent.data.ingest({target:a.handle,sender:'123',externalId:'wake',text:'在吗',receivedAt:now})
 assert.equal(agent.choose(now+4999),null)
 assert.equal(agent.choose(now+5000),a.handle)
 agent.data.acknowledgeAttention(agent.data.attention(now+300000,5000))
 assert.equal(agent.choose(now+10000),null)
})

test('a chosen concern review restores its original view once and stops after revocation',t=>{
 const {agent,store,target}=fixture(t),a=target('123'),b=target('456'),view=agent.data.open(a.handle),now=Date.now()
 store.set('yoyo_started',true);store.set('yoyo_last_focus',b.handle)
 const fields={title:'question',why:'curious',origin:'previous conversation',next:'test',doneWhen:'answer',stopWhen:'no progress',reviewAt:now+1000}
 const c=agent.data.concern(view.id,fields)
 assert.equal(agent.choose(now+999),null)
 assert.equal(agent.choose(now+1000),a.handle)
 assert.equal(agent.wakeView.id,view.id);assert.equal(agent.wakeEvent.concern,c.id)
 assert.ok(agent.decisionPrompt().includes('concern_review_due'))
 assert.equal(agent.decisionPrompt().includes('继续当前活动'),false)
 agent.data.consumeConcernReview(c.id,fields.reviewAt)
 assert.equal(agent.choose(now+2000),null)
 agent.data.concern(view.id,{id:c.id,reviewAt:now+3000})
 agent.data.approve(a.handle,false)
 assert.equal(agent.choose(now+4000),null)
})

test('activity resumption uses its saved scope and an idle clock cannot create work',t=>{
 const {agent,store,target}=fixture(t),a=target('123'),b=target('456'),v=agent.data.open(a.handle),now=Date.now()
 store.set('yoyo_started',true);store.set('yoyo_last_focus',b.handle)
 agent.data.saveActivity(v.id,{state:'waiting',description:'await result',next:'inspect',wakeAt:now+1000})
 assert.equal(agent.choose(now+1000),a.handle);assert.equal(agent.wakeView.id,v.id)
 assert.equal(agent.wakeEvent.kind,'self_scheduled_review')
 agent.data.db.prepare('UPDATE yoyo_activity SET wake_at=NULL').run()
 for(const time of [now+2000,now+60000,now+86400000])assert.equal(agent.choose(time),null)
})


test('memory maintenance blocks message sending and execution at actual native tool dispatch',async t=>{
 const {agent,hooks,target}=fixture(t),a=target('123');agent.activeView=agent.data.open(a.handle);agent.maintenanceJob={after:0,through:10}
 for(const name of ['yoyo_send','yoyo_send_file','yoyo_execute','yoyo_open','yoyo_web','yoyo_activity'])await assert.rejects(()=>hooks.get('tools/pre-execute')({agent:{id:'one-agent'},name},async()=>{throw Error('must not execute')}),/未获/)
 assert.equal(agent.toolsAllowed().has('yoyo_memory'),true)
})


test('background job completion wakes the original authorized scope once and ignores revoked views',async t=>{
 const {agent,store,target}=fixture(t),a=target('123'),view=agent.data.open(a.handle),id='a'.repeat(64)
 store.set('yoyo_started',true);agent.data.saveActivity(view.id,{state:'sleeping',description:'等编译完成',wakeAt:null})
 agent.data.db.prepare('INSERT INTO yoyo_jobs(id,run_key,scopes,created_at,view_id) VALUES(?,?,?,?,?)').run(id,'run-a',JSON.stringify(view.scopes),Date.now(),view.id)
 agent.executor={async call(){return {id,state:'done'}}};await agent.pollJobs()
 assert.equal(agent.choose(),a.handle);assert.equal(agent.readyJob.id,id)
 agent.data.approve(a.handle,false);assert.equal(agent.choose(),null)
 assert.equal(agent.data.db.prepare('SELECT notified FROM yoyo_jobs WHERE id=?').get(id).notified,1)
})


test('merged forward pages preserve the full original and cannot use another window document for attachments',async t=>{
 const {agent,tools,target,exec}=fixture(t),a=target('123'),b=target('456');agent.activeView=agent.data.open(a.handle)
 const original=agent.data.ingest({target:a.handle,sender:'123',externalId:'forward',text:'[forward]',segments:[{type:'forward',data:{id:'source-forward'}}]})
 let reads=0;agent.qq={async call(action){assert.equal(action,'get_forward_msg');reads++;return {messages:[{user_id:'999',message:[{type:'text',data:{text:'x'.repeat(70000)}}]}]}}}
 const first=await tools.get('yoyo_forward').execute({message:original.id,segment:0,characters:12000},exec)
 assert.ok(first.total>70000);assert.equal(first.content.length,12000);assert.equal(first.next,12000)
 const tail=await tools.get('yoyo_forward').execute({message:original.id,segment:0,offset:60000,characters:24000},{...exec,callId:'2'})
 assert.equal(tail.next,null);assert.equal(reads,1)
 agent.activeView=agent.data.open(b.handle)
 const other=agent.data.ingest({target:b.handle,sender:'456',externalId:'other',text:'[forward]',segments:[{type:'forward',data:{id:'other-forward'}}]})
 await assert.rejects(()=>tools.get('yoyo_attachment').execute({message:other.id,document:first.document,node:0,segment:0},{...exec,callId:'3'}),/当前原消息范围/)
})


test('attachment tool lists merged forward children instead of treating the whole forward as a file',async t=>{
 const {agent,tools,target,exec}=fixture(t),a=target('123');agent.activeView=agent.data.open(a.handle)
 const original=agent.data.ingest({target:a.handle,sender:'123',externalId:'forward-children',segments:[{type:'forward',data:{id:'children'}}]})
 agent.qq={async call(){return {messages:[{message:[{type:'image',data:{url:'https://multimedia.nt.qq.com.cn/a'}}]},{message:[{type:'file',data:{file_id:'b'}}]}]}}}
 const result=await tools.get('yoyo_attachment').execute({message:original.id},exec)
 assert.equal(result.forwarded,true);assert.deepEqual(result.attachments,[{node:0,segment:0,type:'image'},{node:1,segment:0,type:'file'}]);assert.ok(result.document)
})
