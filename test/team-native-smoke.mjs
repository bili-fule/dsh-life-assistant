// Opt-in: node test/team-native-smoke.mjs <installed SDK lib/index.js>
// Uses two real native DSH runtimes and a scripted model; no credentials or QQ.
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync } from 'node:fs'
import { resolve,dirname,join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { TeamNativeAdapter } from '../src/team-native-adapter.mjs'

const sdkModule=resolve(process.argv[2]??'.local/team-native-runtime/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js')
const llm=join(dirname(dirname(dirname(sdkModule))),'dsh-llm','lib','index.js')
const root=mkdtempSync(join(tmpdir(),'yoyo-native-proof-')),plugin=join(root,'model.mjs'),patch=join(root,'model.yml')
writeFileSync(plugin,`
import { LlmAdapter } from ${JSON.stringify(pathToFileURL(llm).href)}
class Model extends LlmAdapter {
 resolveModel(provider,model){return Promise.resolve({provider,id:model,name:model})}
 async *stream(options){
  if(process.env.YOYO_PARENT_SECRET)throw Error('Inherited parent environment')
  if(options.tools.some(t=>!t.name.startsWith('team_')))throw Error('Unexpected tool exposure')
  const toolResult=options.messages.findLast(m=>m.role==='tool')
  if(!toolResult){
   const name=process.env.YOYO_TEAM_ROLE==='chat'?'team_send':'team_web'
   if(!options.tools.some(t=>t.name===name))throw Error('Role tool missing')
   const args=JSON.stringify(name==='team_send'?{text:'native chat proof',replyId:'proof-1'}:{url:'https://example.com'})
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'tool-call-delta',index:0,id:'proof-call',name,argumentsDelta:args}
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'proof-call',name,arguments:args}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
  }else if(!JSON.stringify(toolResult).includes('\\"decision\\"')){
   // The explicit-completion contract: the branch ends by calling team_finish, so
   // this scripted model ends the same way a real one has to.
   const args=JSON.stringify({decision:'completed',reason:'scripted role proof finished'})
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'tool-call-delta',index:0,id:'proof-finish',name:'team_finish',argumentsDelta:args}
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'proof-finish',name:'team_finish',arguments:args}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
  }else{
   const text='Native runtime completed '+process.env.YOYO_TEAM_ROLE
   yield {type:'block-start',index:0,blockType:'text'}
   yield {type:'text-delta',index:0,text}
   yield {type:'block-end',index:0,block:{type:'text',text}}
   yield {type:'finish',reason:{kind:'stop'}}
  }
 }
}
export const name='team-proof-model'
export const inject=['llm']
export function apply(ctx){ctx.llm.registerAdapter(['team-proof'],new Model())}
`)
writeFileSync(patch,`- id: llm-deepseek\n  disabled: true\n- insert:\n    - id: team-proof-model\n      name: ${JSON.stringify(plugin)}\n`)
process.env.YOYO_PARENT_SECRET='must-not-inherit'
const adapter=new TeamNativeAdapter({root,sdkModule,providerPatch:patch,provider:'team-proof',model:'proof'})
const calls=[]
await Promise.all(['chat','research'].map(role=>adapter.run({
 agentId:'native-'+role,task:{id:role,role,goal:'Complete the scripted role proof',expiresAt:Date.now()+120000},
 signal:AbortSignal.timeout(120000),
 invoke:async(name,args)=>{calls.push({role,name,args})
  // Mirror the real host answers so the scripted model can see what it already did.
  if(name==='finish')return {decision:args?.decision??'completed',recorded:true}
  if(name==='report')return {recorded:true}
  if(name==='send')return {state:'sent',messageId:'proof-'+role}
  if(name==='step')return {ok:true}
  return {ok:true,text:'fixture public page'}},
})))
assert.ok(calls.some(c=>c.role==='chat'&&c.name==='send'))
assert.ok(calls.some(c=>c.role==='research'&&c.name==='web'))
assert.equal(calls.filter(c=>c.name==='finish').length,2,'both scripted branches ended explicitly')
assert.ok(calls.filter(c=>c.name==='step').length>=4)
delete process.env.YOYO_PARENT_SECRET
console.log('PASS: two independent native DSH processes; role tools, host bridge, progress and scrubbed environment. Traces: '+root)
