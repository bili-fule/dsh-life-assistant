import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCipheriv,createHash,randomBytes } from 'node:crypto'
import { Store } from '../src/store.mjs'
import { processRun,workspacePath,boundedDownload,httpURL } from '../src/tools.mjs'
import { Media,inboundLabel,forwardedText } from '../src/media.mjs'
import { downloadMediaFile } from '../src/download.mjs'
import { uploadMedia,sendMedia,decryptAesEcb,parseAesKey } from '../src/ilink.mjs'
import {deliverOne} from '../src/assistant.mjs'

const python=process.platform==='win32'?'python':'python3'
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'life-tools-')),workspace=join(dir,'workspace');mkdirSync(workspace);const store=new Store(join(dir,'db.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});return {dir,workspace,store}}
function py(script,...args){const r=spawnSync(python,['-c',script,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout}

test('streaming download enforces actual bytes and removes partial files; redirects cannot escape the CDN',async t=>{
  const {workspace}=fixture(t),path=join(workspace,'partial.bin')
  await assert.rejects(()=>downloadMediaFile('https://novac2c.cdn.weixin.qq.com/file',path,{limit:3,fetchImpl:async()=>new Response('1234')}),/大小限制/)
  assert.ok(!existsSync(path))
  await assert.rejects(()=>downloadMediaFile('https://novac2c.cdn.weixin.qq.com/file',path,{fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://example.com/private'}})}),/微信 HTTPS CDN/)
  assert.ok(!existsSync(path))
})

test('an encrypted archive above the old 32 MiB cap streams to disk and is left for the native Agent',async t=>{
  const {workspace,store}=fixture(t),chunk=Buffer.alloc(65536,65),key=randomBytes(16),cipher=createCipheriv('aes-128-ecb',key,null),hash=createHash('md5')
  const count=528;for(let i=0;i<count;i++)hash.update(chunk)
  let emitted=0;const stream=new ReadableStream({pull(controller){if(emitted++<count)controller.enqueue(cipher.update(chunk));else{controller.enqueue(cipher.final());controller.close()}}})
  const raw={message_id:'large-zip',from_user_id:'owner',item_list:[{file_item:{file_name:'dataset.zip',md5:hash.digest('hex'),media:{full_url:'https://novac2c.cdn.weixin.qq.com/file',aes_key:key.toString('base64')}}}]}
  store.captureMessage(raw);store.ingest(raw.message_id,'owner',inboundLabel(raw))
  const media=new Media({workspace,store,config:{python:'must-not-run-a-parser',mediaFetch:async()=>new Response(stream)}})
  const r=await media.prepare(store.nextMessage());assert.match(r.text,/文件尚未打开/);assert.equal(r.assets[0].bytes,count*chunk.length)
  assert.equal(readFileSync(workspacePath(workspace,r.assets[0].path)).length,count*chunk.length)
})

test('one rejected attachment leaves the remaining text and other file available to the Agent',async t=>{
  const {workspace,store}=fixture(t)
  const file=name=>({file_item:{file_name:name,media:{full_url:'https://novac2c.cdn.weixin.qq.com/'+name}}})
  const raw={message_id:'partial',from_user_id:'owner',item_list:[file('too-large.zip'),{text_item:{text:'今晚前完成'}},file('ok.txt')]}
  store.captureMessage(raw);store.ingest(raw.message_id,'owner',inboundLabel(raw))
  const media=new Media({workspace,store,config:{mediaFetch:async url=>url.pathname.includes('too-large')?new Response('',{headers:{'content-length':String(129*1024*1024)}}):new Response('saved')}})
  const r=await media.prepare(store.nextMessage());assert.match(r.text,/128 MiB/);assert.match(r.text,/今晚前完成/);assert.equal(r.assets.length,1);assert.match(r.assets[0].name,/ok.txt/)
})

test('local uploads are indexed without parsing and download checksum failures are reported without a saved asset',async t=>{
  const {workspace,store}=fixture(t),path=join(workspace,'opaque.zip');writeFileSync(path,'unparsed file')
  store.ingest('local','owner','上传文件');store.setInputContext(1,{localFiles:[path]})
  const media=new Media({workspace,store,config:{python:'must-not-run',mediaFetch:async()=>new Response('wrong')}})
  assert.match((await media.prepare(store.nextMessage())).text,/文件尚未打开/)
  const raw={message_id:'bad-hash',from_user_id:'owner',item_list:[{file_item:{file_name:'x.zip',md5:'0'.repeat(32),media:{full_url:'https://novac2c.cdn.weixin.qq.com/file'}}}]}
  store.captureMessage(raw);store.ingest(raw.message_id,'owner',inboundLabel(raw))
  const r=await media.prepare(store.db.prepare('SELECT * FROM inbox WHERE id=2').get());assert.match(r.text,/MD5/);assert.equal(r.assets.length,0)
})
test('real subprocess returns stdout, exit code and bounded output',async()=>{const r=await processRun(process.execPath,['-e','console.log("hello"); process.exit(7)']);assert.equal(r.exitCode,7);assert.equal(r.stdout.trim(),'hello');const big=await processRun(process.execPath,['-e','console.log("x".repeat(5000))'],{maxOutput:100});assert.equal(big.stdout.length,100);assert.ok(big.outputMayBeTruncated)})
test('long subprocess is terminated on timeout',async()=>{const r=await processRun(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:80});assert.ok(r.timedOut);assert.notEqual(r.exitCode,0)})
test('workspace paths cannot escape through parent traversal',t=>{const {workspace}=fixture(t);assert.throws(()=>workspacePath(workspace,'../../secret'));assert.equal(workspacePath(workspace,'new.txt'),join(workspace,'new.txt'));assert.throws(()=>httpURL('file:///etc/passwd'));assert.throws(()=>httpURL('https://user:secret@example.com'))})
test('downloads enforce byte limits and validate redirect destinations for media',async()=>{await assert.rejects(()=>boundedDownload('https://novac2c.cdn.weixin.qq.com/test',{media:true,fetchImpl:async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}})}),/微信 CDN/);await assert.rejects(()=>boundedDownload('https://example.com',{limit:3,fetchImpl:async()=>new Response('1234')}),/大小限制/)})
test('forwarded XML preserves sender, original text and link',()=>{const xml='<msg><appmsg><title>聊天记录</title><recorditem><![CDATA[<recordinfo><datalist><dataitem><sourcename>老师</sourcename><sourcetime>2026-10-18 10:00</sourcetime><datadesc>明天下午交表</datadesc><url>https://example.com/form</url></dataitem></datalist></recordinfo>]]></recorditem></appmsg></msg>';const text=forwardedText(xml);assert.match(text,/老师/);assert.match(text,/明天下午交表/);assert.match(text,/example.com/);assert.throws(()=>forwardedText('<!DOCTYPE msg [<!ENTITY x SYSTEM "file:///etc/passwd">]><msg>&x;</msg>'))})
test('media labels preserve every image, file and voice transcript',()=>{const text=inboundLabel({item_list:[{type:1,text_item:{text:'看下这些'}},{type:2,image_item:{}},{type:4,file_item:{file_name:'notes.docx'}},{type:3,voice_item:{text:'明天记得提醒'}}]});assert.match(text,/图片/);assert.match(text,/notes.docx/);assert.match(text,/明天记得提醒/)})
test('Word and Excel extract actual document text without running macros',async t=>{const {workspace,store}=fixture(t),doc=join(workspace,'notice.docx'),sheet=join(workspace,'table.xlsx');py(`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Submit application tomorrow</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(sys.argv[2],'w') as z:
 z.writestr('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Deadline</t></si></sst>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>19</v></c></row></sheetData></worksheet>')`,doc,sheet);const media=new Media({workspace,store,config:{python}});assert.match((await media.read(doc)).text,/Submit application tomorrow/);assert.match((await media.read(sheet)).text,/A1:Deadline/);assert.match((await media.read(sheet)).text,/B1:19/)})
test('merged ZIP reads chat history and its image with provenance',async t=>{const {workspace,store}=fixture(t),zip=join(workspace,'chat.zip');py(`import zipfile,sys,base64
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('chat.txt','Teacher: deadline tomorrow at 15:00')
 z.writestr('attachments/image.png',base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLzUAAAAASUVORK5CYII='))`,zip);const media=new Media({workspace,store,config:{python},attachments:{saveImage:async()=>({attachmentId:'image-test',name:'image.png'})},});const r=await media.read(zip);assert.match(r.text,/Teacher: deadline tomorrow/);assert.match(r.text,/DSH 原生视觉附件/);assert.ok(r.assets.some(a=>a.kind==='image'));assert.ok(r.assets.some(a=>a.name==='chat.txt'))})
test('ZIP traversal is rejected and never writes outside its extraction root',async t=>{const {workspace,store,dir}=fixture(t),zip=join(workspace,'bad.zip');py(`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('../../escaped.txt','bad')`,zip);const media=new Media({workspace,store,config:{python}});assert.match((await media.read(zip)).text,/越界路径/);assert.equal(existsSync(join(dir,'escaped.txt')),false)})
test('encrypted inbound file downloads and persists a file reference without pre-parsing',async t=>{const {workspace,store}=fixture(t),data=Buffer.from('会议通知：明天下午交表','utf8'),key=randomBytes(16),cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(data),cipher.final()]);const raw={message_id:'file-1',from_user_id:'owner',item_list:[{type:4,file_item:{file_name:'notice.txt',md5:createHash('md5').update(data).digest('hex'),media:{full_url:'https://novac2c.cdn.weixin.qq.com/file',aes_key:key.toString('base64')}}}]};store.captureMessage(raw);store.ingest('file-1','owner',inboundLabel(raw));const row=store.nextMessage();const media=new Media({workspace,store,config:{python,mediaFetch:async()=>new Response(encrypted)}});const r=await media.prepare(row);assert.match(r.text,/文件尚未打开/);assert.ok(!r.text.includes('会议通知'));assert.ok(r.hasMedia);assert.equal(store.inputContext(row.id).assets.length,1);assert.ok(existsSync(workspacePath(workspace,r.assets[0].path)))})
test('outgoing file follows encrypted upload protocol and stable client id',async()=>{const data=Buffer.from('generated result'),sent=[];let uploaded;const item=await uploadMedia({baseUrl:'https://ilinkai.weixin.qq.com',token:'test',to:'owner',data,name:'result.txt',post:async req=>{assert.equal(req.body.media_type,3);assert.equal(req.body.rawsize,data.length);return {upload_full_url:'https://novac2c.cdn.weixin.qq.com/upload'}},fetchImpl:async(url,options)=>{uploaded=options.body;return new Response('',{headers:{'x-encrypted-param':'download-param'}})}});assert.equal(item.type,4);assert.equal(item.file_item.file_name,'result.txt');assert.deepEqual(decryptAesEcb(uploaded,parseAesKey(item.file_item.media.aes_key)),data);await sendMedia({baseUrl:'https://ilinkai.weixin.qq.com',token:'test',to:'owner',contextToken:'context',item,clientId:'stable-id',post:async req=>{sent.push(req.body.msg);return {ret:0}}});assert.equal(sent[0].client_id,'stable-id');assert.equal(sent[0].context_token,'context');assert.equal(sent[0].item_list[0].type,4)})
test('an explicitly requested file sends before a reply backlog even at night',async t=>{const {store}=fixture(t);store.enqueue('reply:1','reply','details');store.enqueue('file:test','file','result');let delivered;await deliverOne(store,async(body,key,kind)=>{delivered={body,key,kind}},Date.parse('2026-10-18T23:00:00+08:00'));assert.equal(delivered.kind,'file')})
test('earlier chat archives remain discoverable after many text-only followups',t=>{const {store}=fixture(t);store.ingest('archive','owner','[文件] chat.zip');store.setInputContext(1,{assets:[{path:'inbox/chat.zip',name:'chat.zip',kind:'file'}]});for(let i=2;i<25;i++){store.ingest(String(i),'owner','补充身份');store.setInputContext(i,{assets:[]})}assert.equal(store.recentAssets()[0].path,'inbox/chat.zip')})
