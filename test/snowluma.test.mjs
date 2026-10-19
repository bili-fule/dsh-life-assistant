import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac,createHash } from 'node:crypto'
import { SnowLuma } from '../src/snowluma.mjs'

const config={token:'interface-token-at-least-16',eventToken:'event-token-at-least-24-characters',account:'10001'}
function response(data,extra={}){return new Response(JSON.stringify({status:'ok',retcode:0,data,...extra}),{headers:{'content-type':'application/json'}})}

test('OneBot HTTP uses bearer authentication and confirms the exact logged-in account',async()=>{
  const calls=[],qq=new SnowLuma({...config,fetchImpl:async(url,args)=>{calls.push({url,args});return response({user_id:10001,nickname:'bot'})}})
  assert.equal((await qq.health()).connected,true)
  assert.equal(calls[0].args.headers.Authorization,'Bearer '+config.token)
  assert.equal(calls[0].args.redirect,'error')
  await assert.rejects(()=>new SnowLuma({...config,fetchImpl:async()=>response({user_id:20002})}).health(),/账号/)
  await assert.rejects(()=>qq.call('set_group_ban',{},undefined,{write:true}),/未获授权/)
})

test('event bearer and optional signature both need to match',()=>{
  const qq=new SnowLuma({...config,eventSecret:'signature-secret'}),body=Buffer.from('{"post_type":"message"}'),signature='sha1='+createHmac('sha1','signature-secret').update(body).digest('hex')
  assert.equal(qq.authorizedEvent({authorization:'Bearer '+config.eventToken,'x-signature':signature},body),true)
  assert.equal(qq.authorizedEvent({authorization:'Bearer wrong','x-signature':signature},body),false)
  assert.equal(qq.authorizedEvent({authorization:'Bearer '+config.eventToken,'x-signature':signature},Buffer.from('changed')),false)
})

test('send checks current authority after health finishes and before the write',async()=>{
  const calls=[],qq=new SnowLuma({...config,fetchImpl:async(url)=>{calls.push(url);return response({user_id:10001})}})
  await assert.rejects(()=>qq.send({platform:'qq',account:'10001',peer:'123',kind:'private'},'hi','key',undefined,()=>{throw Error('revoked')}),/revoked/)
  assert.equal(calls.length,1)
})

test('explicit OneBot failure is definite while transport failure remains uncertain',async()=>{
  const qq=new SnowLuma({...config,fetchImpl:async()=>response(null,{retcode:100,status:'failed',wording:'rejected'})})
  await assert.rejects(()=>qq.call('send_private_msg',{},undefined,{write:true}),e=>e.definitelyNotSent===true)
  const lost=new SnowLuma({...config,fetchImpl:async()=>{throw Error('connection lost')}})
  await assert.rejects(()=>lost.call('send_private_msg',{},undefined,{write:true}),e=>!e.definitelyNotSent)
})


test('QQ image and file delivery use bounded bytes and fixed current-window destinations',async()=>{
 const calls=[],qq=new SnowLuma({...config,fetchImpl:async(url,args)=>{calls.push({url,args:JSON.parse(args.body)});return url.endsWith('get_login_info')?response({user_id:10001}):response({message_id:42,file_id:'file-42'})}})
 const bytes=Buffer.from('image-data'),content={kind:'image',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),name:'test.png'},target={platform:'qq',account:'10001',peer:'123',kind:'private'}
 assert.equal((await qq.sendAsset(target,content,bytes)).messageId,42)
 assert.equal(calls.at(-1).args.user_id,123);assert.equal(calls.at(-1).args.message[0].data.file,'base64://'+bytes.toString('base64'))
 assert.equal((await qq.sendAsset(target,{...content,kind:'file',name:'test.txt'},bytes)).messageId,'file:file-42')
 assert.ok(calls.at(-1).url.endsWith('upload_private_file'))
 const count=calls.length;await assert.rejects(()=>qq.sendAsset(target,content,Buffer.from('changed')),/校验/);assert.equal(calls.length,count)
})
