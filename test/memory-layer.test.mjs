import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { MemoryLayer } from '../src/memory-layer.mjs'

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'yoyo-memory-')),store=new Store(join(dir,'data.sqlite')),data=new SocialStore(store)
  const memory=new MemoryLayer(data)
  const target=(peer,label='同一个昵称',kind='private')=>data.approve(data.discover({platform:'qq',account:'10001',kind,peer,label}).handle,true)
  const say=(handle,sender,externalId,text,extra={})=>data.ingest({target:handle,sender,externalId,text,...extra}).id
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  return {store,data,memory,target,say}
}

test('an episode keeps the real senders and refuses forwarded or mixed identities',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123','电影群','group'),view=data.open(a.handle)
  const first=say(a.handle,'555','m1','那个长镜头我反复看了三遍')
  const second=say(a.handle,'777','m2','我更喜欢结尾的音乐')
  const forwarded=say(a.handle,'555','m3','[转发]他说他喜欢安静',{segments:[{type:'forward',data:{id:'f'}}]})
  const episode=memory.propose(view.id,{kind:'episode',title:'聊到一部电影',role:'participant',scene:'电影群',what:'聊了长镜头和配乐',outcome:'聊得很投入',
    unresolved:'还没聊到导演的其他作品',evidence:{messages:[first,second]}})
  assert.equal(episode.sources,2)
  const stored=memory.inspect(view.id,{kind:'episode',id:episode.id})
  assert.equal(stored.body.participants.length,2)
  assert.deepEqual(stored.body.participants.map(person=>String(person.sender)).sort(),['555','777'])
  assert.equal(stored.body.role,'participant')
  // A forwarded quote cannot establish anyone's identity or preference.
  assert.throws(()=>memory.propose(view.id,{kind:'claim',claimType:'preference',statement:'他喜欢安静',person:{messages:[forwarded]},
    evidence:{messages:[forwarded]},confidence:'told'}),/转发/)
  // Two different senders cannot be merged into one claim.
  assert.throws(()=>memory.propose(view.id,{kind:'claim',claimType:'preference',statement:'他们都喜欢长镜头',person:{messages:[first,second]},
    evidence:{messages:[first,second]},confidence:'told'}),/稳定身份/)
})

test('repetition never becomes a new source and cannot promote an inference',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const first=say(a.handle,'123','r1','我确实不太喜欢语音消息'),second=say(a.handle,'123','r2','在地铁上听不了语音')
  const created=memory.propose(view.id,{kind:'claim',claimType:'preference',statement:'他工作场合不太方便听语音',person:{messages:[first]},
    evidence:{messages:[first]},confidence:'told',context:'工作场合'})
  assert.equal(created.sources,1)
  // The same message cannot be counted again, even with new wording.
  const again=memory.propose(view.id,{kind:'claim',claimType:'preference',statement:'他工作场合不太方便听语音',person:{messages:[first]},
    evidence:{messages:[first]},confidence:'told',context:'工作场合'})
  assert.equal(again.duplicate,true)
  assert.throws(()=>memory.propose(view.id,{kind:'claim',claim:created.id,claimType:'preference',statement:'他工作场合不太方便听语音',
    evidence:{messages:[first]},confidence:'observed'}),/重复的来源/)
  const revised=memory.propose(view.id,{kind:'claim',claim:created.id,claimType:'preference',statement:'他只在工作场合不方便听语音',
    person:{messages:[first,second]},evidence:{messages:[second]},confidence:'observed',context:'工作场合'})
  assert.equal(revised.revised,true)
  assert.deepEqual(revised.added,['event:'+second])
  assert.equal(revised.confidence,'observed')
  const inspected=memory.inspect(view.id,{kind:'claim',id:created.id})
  assert.equal(inspected.body.support.length,2)
  assert.equal(inspected.revisions,2)
  // Reading the same record many times changes nothing.
  for(const _ of [1,2,3,4,5])memory.recall(view.id,{query:'语音'})
  assert.equal(memory.inspect(view.id,{kind:'claim',id:created.id}).body.support.length,2)
})

test('private memory stays out of other windows and the public view',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),b=target('456','另一个群','group'),privateView=data.open(a.handle),other=data.open(b.handle),publicView=data.publicView()
  const message=say(a.handle,'123','p1','这件事只跟你说')
  memory.propose(privateView.id,{kind:'episode',title:'一次私下聊天',role:'participant',what:'说了烦心事',evidence:{messages:[message]}})
  assert.equal(memory.recall(privateView.id).results.length,1)
  assert.equal(memory.recall(publicView.id).results.length,0)
  assert.equal(memory.recall(other.id).results.length,0)
  const episode=memory.recall(privateView.id).results[0]
  assert.throws(()=>memory.inspect(other.id,{kind:'episode',id:episode.id}),/资料范围/)
  assert.throws(()=>memory.propose(publicView.id,{kind:'claim',claimType:'fact',statement:'他最近很累',evidence:{messages:[message]},confidence:'observed'}),/资料范围/)
})

test('forgetting blocks re-derivation from the same original wording or not',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const first=say(a.handle,'123','f1','这件事我不想留'),second=say(a.handle,'123','f2','真的别记')
  const episode=memory.propose(view.id,{kind:'episode',title:'一段不想留下的对话',what:'说了私事',evidence:{messages:[first,second]}})
  const forget=memory.retract(view.id,{kind:'episode',id:episode.id,mode:'forget',reason:'用户要求忘掉'})
  assert.equal(forget.status,'retracted')
  assert.equal(memory.recall(view.id).results.length,0)
  // A differently worded summary of the same messages cannot bring it back.
  assert.throws(()=>memory.propose(view.id,{kind:'episode',title:'另外一件小事',what:'随便聊聊',evidence:{messages:[first]}}),/忘记/)
  assert.throws(()=>memory.propose(view.id,{kind:'claim',claimType:'fact',statement:'他提过私事',evidence:{messages:[second]},confidence:'observed'}),/忘记/)
  // The tombstone keeps only what is needed to block a resurrection.
  const tombstones=data.db.prepare('SELECT kind,ref,reason FROM yoyo_memory_retractions').all()
  assert.ok(tombstones.some(row=>row.kind==='source'&&row.ref==='event:'+first))
  assert.equal(JSON.stringify(tombstones).includes('这件事我不想留'),false)
})

test('retracting an experience also retracts the claims derived from it',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const message=say(a.handle,'123','d1','我最近在学画画')
  const episode=memory.propose(view.id,{kind:'episode',title:'聊到画画',what:'他提到在学画画',evidence:{messages:[message]}})
  const claim=memory.propose(view.id,{kind:'claim',claimType:'fact',statement:'他在学画画',subject:'topic:画画',evidence:{messages:[message]},
    confidence:'observed',episode:episode.id})
  memory.retract(view.id,{kind:'episode',id:episode.id,mode:'retract',reason:'记错了'})
  assert.equal(data.db.prepare('SELECT status FROM yoyo_memory_claims WHERE id=?').get(claim.id).status,'retracted')
  assert.equal(memory.recall(view.id,{query:'画画'}).results.length,0)
  assert.throws(()=>memory.inspect(view.id,{kind:'claim',id:claim.id}),/撤回/)
})

test('a differently worded clue still finds the experience, and unknown clues admit ignorance',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123','电影群','group'),view=data.open(a.handle)
  const message=say(a.handle,'555','s1','电影里的长镜头太漂亮了')
  memory.propose(view.id,{kind:'episode',title:'聊电影长镜头',what:'他讲电影里的长镜头怎么拍',evidence:{messages:[message]}})
  const found=memory.recall(view.id,{query:'那部电影镜头'})
  assert.equal(found.results.length,1)
  assert.equal(found.results[0].kind,'episode')
  const missing=memory.recall(view.id,{query:'量子计算'})
  assert.equal(missing.results.length,0)
  assert.match(missing.guidance,/没有记忆不等于没有发生过/)
  // A participant clue narrows without merging identities.
  assert.equal(memory.recall(view.id,{person:'555'}).results.length,1)
  assert.equal(memory.recall(view.id,{person:'999'}).results.length,0)
})

test('simulation is stored as a possibility and never recalled as a past fact',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle),message=say(a.handle,'123','sim1','下次可以一起看')
  assert.throws(()=>memory.propose(view.id,{kind:'claim',claimType:'simulation',statement:'我们当时一起看了电影',evidence:{messages:[message]},confidence:'observed'}),/模拟/)
  const simulated=memory.propose(view.id,{kind:'claim',claimType:'simulation',statement:'我们可能会聊得不错',evidence:{messages:[message]},confidence:'inference'})
  assert.equal(memory.recall(view.id).results.length,0)
  assert.equal(memory.recall(view.id,{includeSimulation:true}).results.length,1)
  assert.equal(memory.inspect(view.id,{kind:'claim',id:simulated.id}).simulated,true)
})

test('inspection pages verbatim originals and drops sources that lost authorization',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const long='x'.repeat(50)
  const message=say(a.handle,'123','i1','第一段'+long+'第二段'+long)
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('run-1','yoyo_web',JSON.stringify(view.scopes),'{"title":"网页摘要"}',Date.now())
  const episode=memory.propose(view.id,{kind:'episode',title:'一段对话',what:'聊了很久',evidence:{messages:[message],receipts:['run-1']}})
  const page=memory.inspect(view.id,{kind:'episode',id:episode.id,source:{type:'message',id:message,offset:0,characters:20}})
  assert.equal(page.source.text.length,20)
  assert.equal(page.source.verbatim,true)
  assert.equal(page.source.next,20)
  assert.equal(page.sources.length,2)
  const receipt=memory.inspect(view.id,{kind:'episode',id:episode.id,source:{type:'receipt',id:'run-1',characters:4000}})
  assert.match(receipt.source.text,/网页摘要/)
  // Revoking the window invalidates the view and the evidence behind it.
  data.approve(a.handle,false)
  assert.throws(()=>memory.inspect(view.id,{kind:'episode',id:episode.id}),/授权/)
})

test('validated procedures need a real tool receipt and usage counts only when used',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle),message=say(a.handle,'123','u1','先跑测试再改')
  assert.throws(()=>memory.propose(view.id,{kind:'claim',claimType:'procedure',statement:'先写测试再改代码',subject:'topic:测试',
    evidence:{messages:[message]},confidence:'observed'}),/工具回执/)
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('job-1','yoyo_job',JSON.stringify(view.scopes),'{"state":"done"}',Date.now())
  const claim=memory.propose(view.id,{kind:'claim',claimType:'procedure',statement:'先写测试再改代码',subject:'topic:测试',
    evidence:{receipts:['job-1']},confidence:'observed'})
  assert.equal(claim.confidence,'observed')
  memory.recall(view.id,{query:''})
  assert.equal(data.db.prepare('SELECT count(*) n FROM yoyo_memory_uses').get().n,0)
  memory.recall(view.id,{query:'测试',used:[{kind:'claim',id:claim.id}]})
  assert.equal(data.db.prepare('SELECT count(*) n FROM yoyo_memory_uses').get().n,1)
  const faded=memory.retract(view.id,{kind:'claim',id:claim.id,mode:'fade',reason:'暂时不想记'})
  assert.equal(faded.status,'faded')
  assert.equal(memory.recall(view.id,{query:'测试'}).results[0].status,'faded')
  const archived=memory.retract(view.id,{kind:'claim',id:claim.id,mode:'archive',reason:'过期了'})
  assert.equal(archived.status,'archived')
  assert.equal(memory.recall(view.id,{query:'测试'}).results.length,0)
})
