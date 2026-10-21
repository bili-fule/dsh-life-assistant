import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { SocialAgent } from '../src/social-agent.mjs'
import { readChunk,CHUNK_DEFAULT,CHUNK_MAX } from '../src/chunk.mjs'

// Every page stays within the window; callers repeat with `next` until it is null.
async function readAll(load,text,extra={}) {
  const pieces=[]
  let offset=0,total=null
  for(let page=0;page<20;page++){
    const result=await load({...extra,offset})
    total=result.total
    pieces.push(result.text)
    if(result.next===null)return {text:pieces.join(''),total,pages:pieces.length}
    offset=result.next
  }
  throw Error('分页没有结束')
}

test('a long text is windowed by offset and never silently dropped',async()=>{
  const text='甲'.repeat(30000)
  const first=readChunk(text)
  assert.equal(first.length,CHUNK_DEFAULT)
  assert.equal(first.total,30000)
  assert.equal(first.truncated,true)
  assert.equal(first.next,CHUNK_DEFAULT)
  const second=readChunk(text,{offset:first.next})
  assert.equal(second.length,CHUNK_DEFAULT)
  assert.equal(second.next,CHUNK_DEFAULT*2)
  const all=await readAll(args=>readChunk(text,args),text)
  assert.equal(all.text,text,'paging the whole text loses nothing')
  assert.equal(all.total,30000)
  assert.equal(all.pages,3)
  // Reading past the end is empty, not an error, and says nothing is left.
  const past=readChunk(text,{offset:40000})
  assert.equal(past.text,'')
  assert.equal(past.truncated,false)
  assert.equal(past.next,null)
  // The window size is bounded so one result can never exceed the model.
  assert.throws(()=>readChunk(text,{characters:CHUNK_MAX+1}),/分页长度/)
  assert.throws(()=>readChunk(text,{characters:0}),/分页长度/)
  assert.throws(()=>readChunk(text,{offset:-1}),/分页起点/)
  assert.throws(()=>readChunk(null),/文本无效/)
})

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'yoyo-chunk-')),store=new Store(join(root,'data.sqlite')),hooks=new Map(),tools=new Map()
  const ctx={on(name,fn){hooks.set(name,fn);return ()=>hooks.delete(name)},systemPrompt:{section(){return ()=>{}},context(){return ()=>{}}},tools:{register(tool){tools.set(tool.name,tool);return ()=>tools.delete(tool.name)}},sessions:{requestViewVersion:1},tokenMeter:{requestViewVersion:1}}
  const runtime={store,abort:new AbortController(),workspace:root,model:{sessionId:'one-agent',async receipt(name,args,exec,body){return body('call:'+exec.callId)}}}
  const agent=new SocialAgent(runtime,ctx,{enabled:true})
  t.after(()=>{agent.stop();store.close();rmSync(root,{recursive:true,force:true})})
  const target=peer=>{const found=agent.data.discover({platform:'qq',account:'1000',kind:'private',peer});return agent.data.approve(found.handle,true)}
  const exec={agent:{id:'one-agent'},signal:runtime.abort.signal,callId:'1',concludeTurn(){}}
  return {agent,store,runtime,tools,target,exec,root}
}

test('an extracted file is read in pages by offset',async t=>{
  const {agent,tools,target,exec,runtime}=fixture(t),view=agent.data.open(target('123').handle)
  agent.activeView=view
  const body='文'.repeat(26000)
  runtime.media={async read(){return {text:body,assets:[]}}}
  const id='asset-1'
  agent.data.db.prepare('INSERT INTO yoyo_assets VALUES(?,?,?,?,?)').run(id,'big.txt',JSON.stringify([...view.scopes].sort()),'big.txt',Date.now())
  const first=await tools.get('yoyo_file').execute({id},exec)
  assert.equal(first.total,26000)
  assert.equal(first.length,CHUNK_DEFAULT)
  assert.equal(first.truncated,true)
  const all=await readAll(args=>tools.get('yoyo_file').execute({id,...args},exec),body)
  assert.equal(all.text,body)
  assert.equal(all.pages,3)
  await assert.rejects(()=>tools.get('yoyo_file').execute({id,characters:CHUNK_MAX+1},exec),/分页长度/)
})

test('a stored public page can be paged again without refetching it',async t=>{
  const {agent,tools,target,exec}=fixture(t),publicView=agent.data.publicView()
  agent.activeView=publicView
  const body='p'.repeat(20000)
  const id=Number(agent.data.db.prepare('INSERT INTO yoyo_documents(url,body,scope,created_at) VALUES(?,?,?,?)').run('https://example.com/a',body,'public',Date.now()).lastInsertRowid)
  const first=await tools.get('yoyo_web').execute({document:id},exec)
  assert.equal(first.total,20000)
  assert.equal(first.length,CHUNK_DEFAULT)
  assert.equal(first.next,CHUNK_DEFAULT)
  const all=await readAll(args=>tools.get('yoyo_web').execute({document:id,...args},exec),body)
  assert.equal(all.text,body)
  assert.equal(all.pages,2)
  // A public page stays readable from any window: the subject may look something
  // up while sitting in a private chat, and the page keeps its own public scope.
  agent.activeView=agent.data.open(target('777').handle)
  assert.equal((await tools.get('yoyo_web').execute({document:id},exec)).total,20000)
  assert.equal(agent.data.db.prepare('SELECT scope FROM yoyo_documents WHERE id=?').get(id).scope,'public')
})
