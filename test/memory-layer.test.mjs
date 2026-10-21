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
  // Two writers editing the same claim: a stale version is refused, not merged.
  const third=say(a.handle,'123','r3','我一般晚上才听语音')
  assert.equal(memory.inspect(view.id,{kind:'claim',id:created.id}).version,2)
  assert.throws(()=>memory.propose(view.id,{kind:'claim',claim:created.id,expectedVersion:1,claimType:'preference',
    statement:'他只在工作场合不方便听语音',person:{messages:[first,second]},evidence:{messages:[third]},confidence:'observed'}),/已被改动过/)
  const current=memory.inspect(view.id,{kind:'claim',id:created.id}).version
  const applied=memory.propose(view.id,{kind:'claim',claim:created.id,expectedVersion:current,claimType:'preference',
    statement:'他在工作场合和白天都不方便听语音',person:{messages:[first,second]},evidence:{messages:[third]},confidence:'observed'})
  assert.equal(applied.version,current+1)
  assert.throws(()=>memory.propose(view.id,{kind:'claim',expectedVersion:1,claimType:'preference',statement:'无对象',evidence:{messages:[first]}}),/只用于修订/)
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

test('candidate segments follow gaps, topic changes and attachments without becoming memories',t=>{
  const {data,memory,target}=fixture(t),a=target('123','电影群','group'),view=data.open(a.handle),base=Date.now()
  const at=(text,sender,offset,extra={})=>data.ingest({target:a.handle,sender,externalId:'seg-'+offset+'-'+sender,text,receivedAt:base+offset,...extra}).id
  at('电影里的长镜头太漂亮了','555',0)
  at('我也喜欢那个长镜头','777',3000)
  at('第二天再说吧','555',3600000)
  at('明天去买菜','777',3600000+3000)
  at('[图片]','555',3600000+6000,{segments:[{type:'image',data:{}}]})
  const result=memory.segments(view.id,{})
  assert.equal(result.segments[0].boundary,'window_start')
  assert.deepEqual(result.segments[0].senders.sort(),['555','777'])
  const reasons=result.segments.map(segment=>segment.boundary)
  assert.ok(reasons.includes('gap'),'a long pause starts a new segment')
  assert.ok(reasons.includes('topic_shift'),'an unrelated topic starts a new segment')
  assert.ok(reasons.includes('attachment'),'an attachment starts a new segment')
  assert.match(result.guidance,/候选分段/)
  // A segment is a proposal: nothing is remembered until the subject writes it.
  assert.equal(memory.recall(view.id).results.length,0)
  // Segmentation needs a concrete window.
  assert.throws(()=>memory.segments(data.publicView().id,{}),/窗口/)
})

test('a candidate segment range can be cited as evidence and stays bounded',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const first=say(a.handle,'123','rng-1','聊到了电影'),second=say(a.handle,'123','rng-2','聊到了配乐')
  const episode=memory.propose(view.id,{kind:'episode',title:'聊电影',what:'聊了长镜头和配乐',evidence:{range:{from:first,to:second}}})
  assert.equal(memory.inspect(view.id,{kind:'episode',id:episode.id}).sources.length,2)
  assert.throws(()=>memory.propose(view.id,{kind:'episode',title:'另一个',what:'x',evidence:{range:{from:first,to:first+60}}}),/分段范围/)
  const fact=memory.propose(view.id,{kind:'claim',claimType:'fact',statement:'他喜欢电影配乐',subject:'topic:音乐',evidence:{messages:[second]},confidence:'observed'})
  const revised=memory.propose(view.id,{kind:'claim',claim:fact.id,claimType:'fact',statement:'他喜欢电影配乐',subject:'topic:音乐',evidence:{messages:[first]},confidence:'observed'})
  assert.equal(revised.added.length,1)
  const recalled=memory.recall(view.id,{query:'配乐'})
  assert.equal(recalled.results.filter(item=>item.kind==='claim').length,1)
  assert.equal(recalled.results.find(item=>item.kind==='claim').support,2)
})

test('a commitment returns once at its trigger and needs real evidence to close',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const message=say(a.handle,'123','c1','研究结果出来我发你')
  const intent=memory.intent(view.id,{statement:'等研究结果回来再聊',kind:'commitment',trigger:'window',about:a.handle,doneWhen:'把结果发给他',
    evidence:{messages:[message]}})
  assert.equal(intent.state,'open')
  assert.equal(intent.trigger,'window')
  // An old message does not trigger it; a real new one does, exactly once.
  assert.equal(memory.dueIntent(Date.now()),null)
  say(a.handle,'123','c2','结果出来了')
  const due=memory.dueIntent(Date.now())
  assert.equal(due.id,intent.id)
  assert.equal(due.reason,'event')
  memory.consumeIntent(due.id,due.consumedRef)
  assert.equal(memory.dueIntent(Date.now()),null)
  say(a.handle,'123','c3','你看到了吗')
  const again=memory.dueIntent(Date.now())
  assert.equal(again.id,intent.id,'a later reply wakes it again')
  memory.consumeIntent(again.id,again.consumedRef)
  // Closing needs a real receipt or an explicit confirmation.
  assert.throws(()=>memory.intent(view.id,{id:intent.id,state:'done'}),/回执|确认/)
  assert.throws(()=>memory.intent(view.id,{id:intent.id,state:'dropped'}),/理由/)
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('self-claim','yoyo_activity',JSON.stringify(view.scopes),'我发过了',Date.now())
  assert.throws(()=>memory.intent(view.id,{id:intent.id,state:'done',receipt:'self-claim'}),/自述/)
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('send-1','yoyo_send',JSON.stringify(view.scopes),'{"state":"sent"}',Date.now())
  const closed=memory.intent(view.id,{id:intent.id,state:'done',receipt:'send-1',reason:'结果已经发给他'})
  assert.equal(closed.state,'done')
  assert.equal(closed.completion.evidence,'tool_receipt')
  assert.equal(memory.intents(view).find(item=>item.id===intent.id).state,'done')
  assert.equal(memory.dueIntent(Date.now()),null)
})

test('time-triggered intents fire after their due time only, and stay inside their scope',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),b=target('456','另一个群','group'),view=data.open(a.handle),other=data.open(b.handle)
  const message=say(a.handle,'123','t1','下周记得问那份资料')
  const due=Date.now()+3600000
  const intent=memory.intent(view.id,{statement:'问那份资料',kind:'intention',trigger:'time',dueAt:due,evidence:{messages:[message]}})
  assert.equal(memory.dueIntent(due-1),null)
  // A private commitment is invisible from another window.
  assert.deepEqual(memory.intents(data.view(other.id)),[])
  assert.equal(memory.dueIntent(due+1).id,intent.id)
  memory.consumeIntent(intent.id,due)
  assert.equal(memory.dueIntent(due+2),null,'the same due time fires once')
  // A time-triggered intent needs a due time, and a commitment needs a condition.
  assert.throws(()=>memory.intent(view.id,{statement:'x',kind:'intention',trigger:'time',evidence:{messages:[message]}}),/dueAt/)
  assert.throws(()=>memory.intent(view.id,{statement:'y',kind:'commitment',trigger:'explicit',evidence:{messages:[message]}}),/完成条件/)
  assert.throws(()=>memory.intent(view.id,{statement:'z',kind:'intention',trigger:'explicit'}),/依据/)
  // Revoking the window means a pending reminder no longer surfaces anywhere.
  const pending=memory.intent(view.id,{statement:'问另一份资料',kind:'intention',trigger:'time',dueAt:Date.now()+1000,evidence:{messages:[message]}})
  data.approve(a.handle,false)
  assert.equal(memory.dueIntent(Date.now()+5000),null,'a revoked window cannot surface a reminder')
  assert.equal(memory.intents(data.view(other.id)).length,0)
  assert.ok(pending.id)
})

test('a generalization needs independent experiences and keeps its counterexamples',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123','技术群','group'),view=data.open(a.handle)
  const episode=(text,sender,id,role='participant')=>{
    const message=say(a.handle,sender,id,text)
    return memory.propose(view.id,{kind:'episode',title:id,role,what:text,evidence:{messages:[message]}}).id
  }
  const first=episode('他解释得很细','555','g1'),second=episode('他总先澄清问题','555','g2'),third=episode('他讲步骤很慢','555','g3')
  assert.throws(()=>memory.generalize(view.id,{claimType:'preference',statement:'他喜欢详细解释',evidence:{episodes:[first]}}),/两条独立经历/)
  assert.throws(()=>memory.generalize(view.id,{claimType:'preference',statement:'他喜欢详细解释',evidence:{episodes:[first,first]}}),/重复计数/)
  const two=memory.generalize(view.id,{claimType:'preference',statement:'他喜欢详细解释',subject:'topic:解释方式',evidence:{episodes:[first,second]}})
  assert.equal(two.confidence,'inference')
  const three=memory.generalize(view.id,{claimType:'preference',statement:'他解释时先澄清再展开',subject:'topic:解释方式',evidence:{episodes:[first,second,third]}})
  assert.equal(three.confidence,'observed')
  assert.equal(three.support,3)
  const contrary=episode('这次他说不想细讲','555','g4')
  const mixed=memory.generalize(view.id,{claimType:'preference',statement:'他通常喜欢详细解释',subject:'topic:解释风格',
    evidence:{episodes:[first,second,third]},counter:{episodes:[contrary]}})
  assert.equal(mixed.confidence,'inference')
  assert.equal(mixed.counter,1)
  assert.match(mixed.message,/反例/)
  // Retracting one supporting experience retracts the generalization too.
  memory.retract(view.id,{kind:'episode',id:first,mode:'retract',reason:'记错了'})
  assert.throws(()=>memory.inspect(view.id,{kind:'claim',id:three.id}),/撤回/)
  assert.equal(memory.recall(view.id,{query:'解释'}).results.some(item=>item.id===three.id),false)
  // Rewriting the same conclusion cannot revive the retracted record: the new
  // claim must stand on its own remaining evidence, and only as an inference.
  const rebuilt=memory.generalize(view.id,{claimType:'preference',statement:'他解释时先澄清再展开',subject:'topic:解释方式',evidence:{episodes:[second,third]}})
  assert.notEqual(rebuilt.id,three.id)
  assert.equal(rebuilt.confidence,'inference')
})

test('impressions keep familiarity and trust apart for the same person',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const episode=(text,id)=>{const message=say(a.handle,'555',id,text);return memory.propose(view.id,{kind:'episode',title:id,what:text,evidence:{messages:[message]}}).id}
  const first=episode('他又来了，聊得很熟','i1'),second=episode('这次他帮我看了半天','i2')
  const firstMessage=data.db.prepare('SELECT id FROM yoyo_events WHERE sender=? ORDER BY id LIMIT 1').get('555').id
  assert.throws(()=>memory.generalize(view.id,{claimType:'impression',statement:'和他聊天比较放松',
    person:{messages:[firstMessage]},evidence:{episodes:[first,second]}}),/哪一面/)
  const familiar=memory.generalize(view.id,{claimType:'impression',dimension:'familiarity',statement:'和他聊天比较放松',
    person:{messages:[firstMessage]},evidence:{episodes:[first,second]}})
  const trust=memory.generalize(view.id,{claimType:'impression',dimension:'trust',statement:'技术上还不确定能不能信',
    person:{messages:[firstMessage]},evidence:{episodes:[first,second]}})
  assert.notEqual(familiar.id,trust.id)
  const impressions=memory.recall(view.id,{query:'聊'}).results.filter(item=>item.claimType==='impression')
  assert.deepEqual(impressions.map(item=>item.dimension).sort(),['familiarity','trust'])
})

test('legacy memories arrive as unverified claims and migrate only once',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),view=data.open(a.handle)
  const message=say(a.handle,'123','legacy-1','他喜欢长镜头')
  const procedure=say(a.handle,'123','legacy-2','先跑测试再改代码')
  const kept=data.remember(view.id,{kind:'episodes',body:'他喜欢电影里的长镜头',sources:[{id:message,quote:'长镜头'}],confidence:'observed'})
  data.remember(view.id,{kind:'procedures',body:'先跑测试再改代码',sources:[{id:procedure,quote:'先跑测试'}],confidence:'self_report'})
  const first=memory.migrateLegacy()
  assert.equal(first.migrated,2)
  const rows=data.db.prepare('SELECT kind,confidence,body,scopes FROM yoyo_memory_claims ORDER BY id').all()
  assert.deepEqual(rows.map(row=>row.confidence),['inference','inference'],'migration never raises confidence')
  assert.deepEqual(rows.map(row=>row.kind),['fact','procedure'])
  assert.equal(JSON.parse(rows[0].body).needsReview,true)
  assert.deepEqual(JSON.parse(rows[0].scopes),JSON.parse(data.db.prepare('SELECT scopes FROM yoyo_memories WHERE id=?').get(kept.id).scopes))
  // Running it again changes nothing, and the old rows stay active.
  assert.equal(memory.migrateLegacy().migrated,0)
  assert.equal(data.db.prepare('SELECT count(*) n FROM yoyo_memories WHERE active=1').get().n,2)
  const recalled=memory.recall(view.id,{query:'长镜头'})
  assert.equal(recalled.results.length,1)
  assert.equal(recalled.results[0].confidence,'inference')
  assert.match(memory.inspect(view.id,{kind:'claim',id:recalled.results[0].id}).body.note,/旧记忆迁移/)
})

test('wakes are counted and a reminder that keeps being ignored goes quiet',t=>{
  const {data,memory,target,say}=fixture(t),a=target('123'),b=target('456','另一个群','group'),view=data.open(a.handle),other=data.open(b.handle)
  const message=say(a.handle,'123','w1','周五之前给你答复')
  const intent=memory.intent(view.id,{statement:'周五前答复他',kind:'commitment',trigger:'window',about:a.handle,
    doneWhen:'把答复发出来',evidence:{messages:[message]}})
  assert.deepEqual(memory.summary(view).wakes,{delivered:0,done:0,dropped:0,ignored:0,open:0})
  // Each real wake is recorded; a later wake before closing means the earlier
  // reminder achieved nothing, so only the newest one stays open.
  for(const [index,text] of ['在吗','答复呢','你还没回我','最后一次问'].entries()){
    say(a.handle,'123','wake-'+index,text)
    const due=memory.dueIntent(Date.now())
    assert.equal(due.id,intent.id)
    memory.consumeIntent(due.id,due.consumedRef)
    const stats=memory.summary(view).wakes
    assert.equal(stats.delivered,index+1)
    assert.equal(stats.ignored,index)
    assert.equal(stats.open,1)
  }
  const listed=memory.intents(view).find(item=>item.id===intent.id)
  assert.equal(listed.wakes.ignored,3)
  assert.equal(listed.nagMuted,true,'three ignored reminders silence the window trigger')
  say(a.handle,'123','wake-late','忙完了吗')
  assert.equal(memory.dueIntent(Date.now()),null,'a muted reminder stops nagging')
  // Closing it resolves the outstanding wake as a real outcome, not a success story.
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('send-w','yoyo_send',JSON.stringify(view.scopes),'{"state":"sent"}',Date.now())
  memory.intent(view.id,{id:intent.id,state:'done',receipt:'send-w',reason:'答复已经发过去了'})
  const closed=memory.summary(view).wakes
  assert.equal(closed.done,1)
  assert.equal(closed.ignored,3)
  assert.equal(closed.open,0)
  assert.equal(memory.intents(view).find(item=>item.id===intent.id).nagMuted,false)
  // Wake counts stay inside their scope.
  assert.deepEqual(memory.summary(data.view(other.id)).wakes,{delivered:0,done:0,dropped:0,ignored:0,open:0})
})
