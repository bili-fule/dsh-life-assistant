import test from 'node:test'
import assert from 'node:assert/strict'
import { DebugHelper } from '../src/debug-helper.mjs'

test('helper receives structural diagnostics only; results remain in their originating window',async()=>{
 const saved=new Map(),calls=[]
 const social={nativeReady:true,separate:true,activeView:{focus:'chat-a'},data:{
  target(){return {kind:'private',peer:'PRIVATE_ID',label:'PRIVATE_NAME'}},
  db:{prepare(sql){return {run(){},all(){return sql.includes('tool_runs')?[{name:'yoyo_open',state:'failed',created_at:1}]:[]}}}}
 },store:{set(k,v){saved.set(k,v)},get(k){return saved.get(k)}}}
 const helper=new DebugHelper(social),id='a'.repeat(64)
 helper.call=async(path,args)=>{calls.push({path,args});return {id,state:path==='/start'?'running':'done',report:'verified report'}}
 const view={scopes:['public','chat-a']}
 await helper.start({problem:'窗口没有切换，请核对导航逻辑'},view,'native-call',new AbortController().signal)
 assert.equal(calls[0].args.key,'native-call')
 assert.equal(JSON.stringify(calls[0]).includes('PRIVATE'),false)
 assert.equal((await helper.status({id},view)).state,'done')
 const before=calls.length
 await assert.rejects(()=>helper.status({id},{scopes:['public','chat-b']}),/范围/)
 await assert.rejects(()=>helper.patch({id,offset:0},{scopes:['public']}),/范围/)
 assert.equal(calls.length,before)
 await assert.rejects(()=>helper.status({id:'../../root'},view),/编号/)
 await assert.rejects(()=>helper.start({problem:' '},view,'x'),/非空/)
})
