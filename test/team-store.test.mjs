import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { ROLE_TOOLS } from '../src/team-store.mjs'
import { TeamCoordinator } from '../src/team-coordinator.mjs'
import { TeamMotivation } from '../src/team-motivation.mjs'

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'team-')),store=new Store(join(dir,'test.sqlite')),social=new SocialStore(store)
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  const view=peer=>{const target=social.discover({platform:'qq',account:'1',kind:'private',peer,label:'same'});social.approve(target.handle,true);return social.open(target.handle)}
  const a=view('2'),b=view('3'),team=new TeamStore(social,()=>100)
  const create=(key,v=a,role='chat')=>team.create({key,role,goal:'secret goal',viewId:v.id,expiresAt:1000})
  // Another platform in the same database is a genuinely independent subject:
  // its view carries only ['public', its own scope], never the QQ windows.
  const wechat=(peer='alice')=>{const t=social.discover({platform:'wechat',account:'bound',kind:'owner',peer});return social.approve(t.handle,true)}
  const wc=()=>social.open(wechat().handle)
  return {team,social,store,a,b,create,wechat,wc}
}
test('parallel task authorities never inherit the current window, reports stay scoped',t=>{  const {team,a,b,create,wc}=fixture(t),x=create('x'),y=create('y',b)
  team.claim(x.id,'worker-x');team.claim(y.id,'worker-y')
  assert.equal(team.authority('worker-x').view.id,a.id)
  assert.equal(team.authority('worker-y').view.id,b.id)
  team.report('worker-x','private finding')
  // The same subject's other window is the same reader; another subject is not.
  assert.equal(team.reports(x.id,b.id)[0].body,'private finding')
  assert.throws(()=>team.reports(x.id,wc().id),/范围/,'an independent subject reads no QQ report')
  assert.equal(team.reports(x.id,a.id)[0].body,'private finding')
  assert.ok(!JSON.stringify(team.overview()).includes('secret'))
  assert.ok(!JSON.stringify(team.overview()).includes('private finding'))
})
test('single speaker, takeover fences delayed sends and reports',t=>{
  const {team,a,create}=fixture(t),x=create('x'),y=create('y')
  team.claim(x.id,'worker-x')
  assert.throws(()=>team.claim(y.id,'worker-y'),/发言者/)
  assert.equal(team.inspect(y.id,a.id).state,'ready')
  assert.equal(team.authorizeSend('worker-x',a.focus,1),true)
  const generation=team.takeover(a.id,'main',1000)
  assert.equal(generation,2)
  assert.throws(()=>team.authorizeSend('worker-x',a.focus,1),/失效/)
  assert.throws(()=>team.report('worker-x','late'),/失效/)
  assert.equal(team.authorizeSend('main',a.focus,2),true)
})
test('revocation invalidates running authority; private material cannot become public research',t=>{
  const {team,social,a,create}=fixture(t),x=create('x')
  team.claim(x.id,'worker')
  // A research branch delegated from a private window gets its own public-only
  // view instead of the caller's scopes: the branch itself stays blind.
  const research=create('research',a,'research')
  assert.deepEqual(social.view(research.view_id).scopes,['public'])
  assert.equal(research.focus_key,'','a research branch holds no window')
  assert.deepEqual(ROLE_TOOLS.research.filter(name=>['send','read','wait'].includes(name)),[],
    'research still cannot speak and cannot read a private window')
  social.approve(a.focus,false)
  assert.throws(()=>team.authority('worker'))
  assert.throws(()=>team.authorizeSend('worker',a.focus,1))
})
test('durable authority and reports survive registry reconstruction; completion fences writes',t=>{
  const {team,social,a,create}=fixture(t),x=create('x')
  team.claim(x.id,'worker');team.report('worker','evidence')
  const recovered=new TeamStore(social,()=>100)
  assert.equal(recovered.authority('worker').view.id,a.id)
  assert.equal(recovered.reports(x.id,a.id)[0].body,'evidence')
  recovered.finish('worker')
  assert.throws(()=>team.authorizeSend('worker',a.focus,1),/失效/)
  assert.throws(()=>team.report('worker','late'),/失效/)
})
test('public research coexists with chat; deadlines and duplicate task keys are checked',t=>{
  const {team,social,create}=fixture(t),x=create('x'),publicView=social.publicView(),r=create('r',publicView,'research')
  team.claim(x.id,'chat');team.claim(r.id,'search')
  assert.deepEqual(team.authority('search').view.scopes,['public'])
  assert.equal(create('x').id,x.id)
  assert.throws(()=>team.create({key:'x',role:'chat',goal:'different',viewId:x.view_id,expiresAt:1000}),/冲突/)
  const expired=new TeamStore(social,()=>1001)
  assert.throws(()=>expired.report('search','late'),/失效/)
})
test('takeover authority also expires after window permission changes',t=>{
  const {team,social,a}=fixture(t)
  team.takeover(a.id,'main',1000)
  social.approve(a.focus,false);social.approve(a.focus,true)
  assert.throws(()=>team.authorizeSend('main',a.focus,1))
})
test('coordinator runs chat and research concurrently and enforces role tools',async t=>{
  const {team,social,create}=fixture(t),chat=create('chat'),research=create('research',social.publicView(),'research')
  let release;const gate=new Promise(resolve=>{release=resolve}),seen=[]
  const coordinator=new TeamCoordinator({tasks:team,adapter:{async run({task,invoke}){
    seen.push(task.role)
    await gate
    if(task.role==='chat'){
      await assert.rejects(invoke('web',{}),/权限/)
      await invoke('send',{text:'hello'})
    }else{
      await assert.rejects(invoke('send',{text:'bad'}),/权限/)
      await invoke('web',{url:'https://example.com'})
    }
    await invoke('report',{body:'done'})
  }},tools:{send:async({authorize})=>{authorize();return {queued:true}},web:async()=>({text:'public'})}})
  coordinator.start(chat.id);coordinator.start(research.id)
  await Promise.resolve()
  assert.deepEqual(seen,['chat','research'])
  release()
  const results=await Promise.all([coordinator.settle(chat.id),coordinator.settle(research.id)])
  assert.deepEqual(results,[{state:'completed'},{state:'completed'}])
})
test('cancel while delivery is pending rejects the late dispatch',async t=>{
  const {team,a,create}=fixture(t),chat=create('chat')
  let pending,release;const arrived=new Promise(r=>{pending=r}),gate=new Promise(r=>{release=r});let sent=false
  const coordinator=new TeamCoordinator({tasks:team,adapter:{run:({invoke})=>invoke('send',{text:'late'})},tools:{
    send:async({authorize})=>{pending();await gate;authorize();sent=true;return {}}
  }})
  coordinator.start(chat.id);const done=coordinator.settle(chat.id)
  await arrived;coordinator.cancel(chat.id,a.id);release();await done
  assert.equal(sent,false)
  assert.equal(team.inspect(chat.id,a.id).state,'cancelled')
})
test('motivated delegation preserves reasons, scope and explicit stopping conditions',t=>{
  const {team,social,a,wc}=fixture(t),motivation=new TeamMotivation(team),w=wc()
  const concern=social.concern(a.id,{title:'understand',why:'curiosity',origin:'conversation',next:'ask',doneWhen:'answered',stopWhen:'no interest'})
  const args={key:'motivated',role:'chat',goal:'discuss',viewId:a.id,expiresAt:1000,concernId:concern.id,rationale:'continue discussion while I investigate'}
  const task=motivation.delegate(args)
  assert.equal(motivation.delegate(args).id,task.id)
  // The subject's own window keeps the concern and the work; another subject sees neither.
  assert.throws(()=>motivation.delegate({...args,key:'other',viewId:w.id}),/关切/)
  assert.equal(motivation.deliberate(a.id).work[0].stopWhen,'no interest')
  assert.deepEqual(motivation.deliberate(w.id).work,[])
  team.claim(task.id,'worker');team.report('worker','I think solved');team.finish('worker')
  const report=team.reports(task.id,a.id)[0]
  const review=motivation.review(a.id,{taskId:task.id,decision:'wait',reason:'need evidence',reportId:report.id})
  assert.equal(review.evidence,'worker_report')
  assert.equal(review.automaticallyScheduled,false)
  assert.equal(social.concerns(a.id)[0].state,'active')
  assert.throws(()=>motivation.review(w.id,{taskId:task.id,decision:'done',reason:'bad'}),/范围/)
  social.concern(a.id,{id:concern.id,state:'abandoned'})
  assert.throws(()=>motivation.delegate({...args,key:'new'}),/活跃/)
})

test('a task evidence board stays inside its subject and steering is consumed once',t=>{
  const {team,a,b,create,wc}=fixture(t),w=wc(),x=create('x'),y=create('y',b)
  team.claim(x.id,'worker-x');team.claim(y.id,'worker-y')
  const shared=team.evidence('worker-x',{kind:'finding',body:'只在这个窗口读到的材料',source:'event:42'})
  assert.equal(shared.taskId,x.id)
  assert.equal(team.board(a.id,{taskId:x.id}).length,1)
  assert.equal(team.board(a.id,{taskId:x.id})[0].body,'只在这个窗口读到的材料')
  // The subject's other window is the same reader; another subject reads nothing.
  assert.equal(team.board(b.id,{taskId:x.id}).length,1)
  assert.deepEqual(team.board(w.id),[])
  assert.throws(()=>team.board(w.id,{taskId:x.id}),/范围/)
  assert.throws(()=>team.evidence('nobody',{body:'伪造的证据'}),/授权/)
  assert.throws(()=>team.evidence('worker-x',{kind:'rumour',body:'x'}),/证据类型/)
  // The worker's own board never leaks another task's material.
  assert.deepEqual(team.board(b.id,{taskId:y.id}),[])
  assert.equal(team.steer(a.id,{taskId:x.id,message:'顺便看一下评论区'}).delivered,false)
  assert.deepEqual(team.takeSteers('worker-x'),['顺便看一下评论区'])
  assert.deepEqual(team.takeSteers('worker-x'),[])
  team.finish('worker-x')
  assert.throws(()=>team.steer(a.id,{taskId:x.id,message:'太晚了'}),/进行中/)
  assert.throws(()=>team.steer(w.id,{taskId:x.id,message:'越范围'}),/范围/)
})

test('evidence is one row per real source and cross-task search stays inside the subject',t=>{
  const {team,a,b,create,wc}=fixture(t),w=wc(),x=create('x'),reader=create('reader',a,'reader')
  team.claim(x.id,'worker-x');team.claim(reader.id,'worker-r')
  const first=team.evidence('worker-x',{kind:'source',source:'https://example.com/film',body:'长镜头在结尾出现两次'})
  assert.equal(first.duplicate,undefined)
  // The same page and the same words are one piece of evidence, not two votes.
  const again=team.evidence('worker-x',{kind:'source',source:'https://example.com/film',body:'长镜头在结尾出现两次'})
  assert.equal(again.id,first.id)
  assert.equal(again.duplicate,true)
  assert.equal(team.board(a.id,{taskId:x.id}).length,1)
  // A different reading of the same source is kept, but flagged as a disagreement.
  const differing=team.evidence('worker-x',{kind:'excerpt',source:'https://example.com/film',body:'长镜头只在开头出现一次'})
  assert.equal(differing.conflict,true)
  assert.equal(team.board(a.id,{taskId:x.id}).length,2)
  const other=team.evidence('worker-r',{kind:'finding',body:'评论区也在讨论长镜头的剪辑',source:'event:88'})
  // A later task reaches what an earlier task really read inside the same subject.
  const found=team.searchEvidence(a.id,{query:'长镜头'})
  assert.deepEqual(found.map(row=>row.id).sort(),[first.id,differing.id,other.id].sort())
  assert.equal(found[0].score>=found[found.length-1].score,true)
  assert.deepEqual(team.searchEvidence(b.id,{query:'长镜头'}).map(row=>row.id).sort(),found.map(row=>row.id).sort(),
    'the subject reads its own windows')
  assert.deepEqual(team.searchEvidence(w.id,{query:'长镜头'}),[],'another subject sees nothing')
  assert.deepEqual(team.searchEvidence(a.id,{query:'长镜头',kind:'finding'}).map(row=>row.id),[other.id])
  assert.throws(()=>team.searchEvidence(a.id,{query:'   '}),/线索/)
  assert.throws(()=>team.searchEvidence(a.id,{query:'长镜头',limit:99}),/条数/)
  assert.throws(()=>team.searchEvidence(a.id,{query:'长镜头',kind:'rumour'}),/类型/)
})

test('a worker memory candidate is only a candidate until the subject decides',t=>{
  const {team,a,b,create,wc}=fixture(t),x=create('x')
  team.claim(x.id,'worker-x')
  const submitted=team.memoryCandidate('worker-x',{kind:'claim',claimType:'preference',statement:'对方更喜欢语音而不是打字',
    context:'聊到沟通方式',evidence:{messages:[1,2]}})
  assert.equal(submitted.state,'pending')
  // The same candidate is not queued twice.
  assert.equal(team.memoryCandidate('worker-x',{kind:'claim',claimType:'preference',statement:'对方更喜欢语音而不是打字',
    context:'聊到沟通方式',evidence:{messages:[1,2]}}).duplicate,true)
  assert.equal(team.memoryCandidates(a.id).length,1)
  assert.equal(team.memoryCandidates(b.id).length,1,'the subject reads its own windows')
  assert.deepEqual(team.memoryCandidates(wc().id),[],'another subject sees no candidates')
  // A worker cannot hand over identity or habit claims, and needs real sources.
  assert.throws(()=>team.memoryCandidate('worker-x',{kind:'claim',claimType:'impression',statement:'他很内向',evidence:{messages:[1]}}),/身份/)
  assert.throws(()=>team.memoryCandidate('worker-x',{kind:'claim',claimType:'fact',statement:'没有依据'}),/依据/)
  assert.throws(()=>team.memoryCandidate('nobody',{kind:'claim',claimType:'fact',statement:'x',evidence:{messages:[1]}}),/授权/)
  const candidate=team.memoryCandidates(a.id)[0]
  // Accepting is the subject's decision, and it happens at most once.
  assert.equal(team.decideMemory(a.id,{id:candidate.id,decision:'accept',claimId:77}).state,'accepted')
  assert.throws(()=>team.decideMemory(a.id,{id:candidate.id,decision:'reject',reason:'晚了'}),/处理过/)
  assert.deepEqual(team.memoryCandidates(a.id),[])
  assert.equal(team.memoryCandidates(a.id,{state:'accepted'})[0].claimId,77)
  const second=team.memoryCandidate('worker-x',{kind:'episode',statement:'聊过一次沟通方式',context:'他在地铁上不方便听语音',
    evidence:{messages:[3]}})
  assert.throws(()=>team.decideMemory(a.id,{id:second.id,decision:'reject'}),/理由/)
  const rejected=team.decideMemory(a.id,{id:second.id,decision:'reject',reason:'这段没有真实新增内容'})
  assert.equal(rejected.state,'rejected')
  assert.match(rejected.reason,/没有真实新增内容/)
  assert.equal(team.memoryCandidates(a.id,{state:'rejected'})[0].statement,'聊过一次沟通方式')
  assert.throws(()=>team.candidate(wc().id,second.id),/范围/)
})

test('a memory pack belongs to one task and its subject',t=>{
  const {team,a,b,create,wc}=fixture(t),x=create('x'),y=create('y',b)
  assert.equal(team.memoryPack(x.id,a.id),null)
  const written=team.writeMemoryPack(x.id,a.id,{clue:'聊过的电影',items:[{id:1,kind:'episode',title:'聊到一部电影'}]})
  assert.equal(written.items,1)
  const pack=team.memoryPack(x.id,a.id)
  assert.equal(pack.clue,'聊过的电影')
  assert.equal(pack.items[0].kind,'episode')
  // Only summaries are carried; the same subject's other window reads it, another subject does not.
  assert.deepEqual(team.memoryPack(y.id,b.id),null)
  assert.equal(team.memoryPack(x.id,b.id).clue,'聊过的电影')
  assert.throws(()=>team.memoryPack(x.id,wc().id),/范围/)
  // Re-writing replaces the pack instead of stacking old summaries.
  team.writeMemoryPack(x.id,a.id,{clue:'聊过的电影',items:[]})
  assert.deepEqual(team.memoryPack(x.id,a.id).items,[])
  assert.throws(()=>team.writeMemoryPack(x.id,a.id,{clue:'',items:[]}),/线索/)
  assert.throws(()=>team.writeMemoryPack(x.id,a.id,{clue:'聊过的电影',items:new Array(9).fill({})}),/条数/)
})

test('the engineering role starts public, cannot speak and can only narrow its tools',t=>{
  const {team,social,a,create}=fixture(t),publicView=social.publicView()
  // Private material never reaches a code runner: the branch gets a public view.
  const private_=create('eng-private',a,'engineer')
  assert.deepEqual(social.view(private_.view_id).scopes,['public'])
  assert.equal(private_.focus_key,'','an engineering branch holds no window')
  assert.equal(private_.toolset,null,'the role toolset is unchanged')
  const task=create('eng',publicView,'engineer')
  assert.equal(task.role,'engineer')
  assert.deepEqual(ROLE_TOOLS.engineer.filter(name=>['send','read','wait','web'].includes(name)),[],
    'engineering has no speaking, window or web tools')
  assert.equal(ROLE_TOOLS.engineer.includes('execute'),true)
  assert.equal(ROLE_TOOLS.engineer.includes('job'),true)
  team.claim(task.id,'worker-e')
  assert.equal(team.authority('worker-e').task.role,'engineer')
  assert.throws(()=>team.authorizeSend('worker-e','public',1),/权限|发言|失效|窗口/)
  // Narrowing is allowed, widening is not.
  const narrowed=team.create({key:'eng-narrow',role:'engineer',goal:'g',viewId:publicView.id,expiresAt:1000,toolset:['execute','report']})
  assert.deepEqual(JSON.parse(narrowed.toolset),['execute','report'])
  assert.throws(()=>team.create({key:'eng-wide',role:'engineer',goal:'g',viewId:publicView.id,expiresAt:1000,toolset:['send']}),/属于该角色/)
})

test('a peer executor reaches nearly everything but never the control plane',t=>{
  const {team,social,a,create}=fixture(t),publicView=social.publicView(),peer=create('peer',a,'peer')
  // Reach: the subject's own reading, searching, files, browsing, code and memory.
  for(const name of ['read','search','message','file','attachment','forward','recall','web','execute','job','send',
    'memory_recall','memory_inspect','memory_propose','memory_segments','memory_generalize'])
    assert.equal(ROLE_TOOLS.peer.includes(name),true,'peer 具备 '+name)
  // Control plane stays with the subject.
  for(const name of ['open','attention','mute','dismiss','cancel','delegate','deliver','memory_retract'])
    assert.equal(ROLE_TOOLS.peer.includes(name),false,'peer 没有 '+name)
  // A peer may work in a window and takes the speaker lease like chat.
  assert.equal(peer.role,'peer')
  team.claim(peer.id,'worker-peer')
  const second=create('peer-2',a,'peer')
  assert.throws(()=>team.claim(second.id,'worker-peer-2'),/发言者/,'同一窗口只能有一个发言租约')
  team.takeover(a.id,'main',Date.now()+900000)
  assert.throws(()=>team.authorizeSend('worker-peer',a.focus,1),/失效/,'主体接管后同伴不能再发')
  // Public work is allowed too, and narrowing still cannot widen.
  const public_=create('peer-public',publicView,'peer')
  assert.equal(public_.role,'peer')
  const narrowed=team.create({key:'peer-narrow',role:'peer',goal:'g',viewId:publicView.id,expiresAt:1000,toolset:['read','report']})
  assert.deepEqual(JSON.parse(narrowed.toolset),['read','report'])
  assert.throws(()=>team.create({key:'peer-wide',role:'peer',goal:'g',viewId:publicView.id,expiresAt:1000,toolset:['open']}),/属于该角色/)
})

test('the source registry shows repeated readings and cross-task disagreements',t=>{
  const {team,a,b,create,wc}=fixture(t),x=create('x'),reader=create('reader',a,'reader'),other=create('other',b)
  team.claim(x.id,'worker-x');team.claim(reader.id,'worker-r');team.claim(other.id,'worker-o')
  team.evidence('worker-x',{kind:'source',source:'https://example.com/a',body:'文章说长镜头出现在结尾'})
  team.evidence('worker-r',{kind:'excerpt',source:'https://example.com/a',body:'文章说长镜头出现在开头'})
  team.evidence('worker-r',{kind:'finding',body:'没有来源标注的发现'})
  team.evidence('worker-o',{kind:'source',source:'https://example.com/a',body:'另一个窗口读到的内容'})
  const registry=team.sourceRegistry(a.id)
  assert.equal(registry.length,1,'an unlabelled finding is not a source')
  assert.equal(registry[0].source,'https://example.com/a')
  // The subject's other window is the same reader: three readings, three wordings.
  assert.equal(registry[0].readings,3)
  assert.equal(registry[0].distinct,3)
  assert.equal(registry[0].conflict,true)
  assert.deepEqual(registry[0].tasks.sort(),[x.id,reader.id,other.id].sort())
  // An independent subject reads no QQ row, so its registry stays empty.
  assert.deepEqual(team.sourceRegistry(wc().id),[])
  // Re-reading the same words is not a second reading of a different kind.
  team.evidence('worker-x',{kind:'source',source:'https://example.com/a',body:'文章说长镜头出现在结尾'})
  assert.equal(team.sourceRegistry(a.id)[0].readings,3)
  assert.throws(()=>team.sourceRegistry(a.id,{limit:99}),/条数/)
})

test('task budgets are counted per attempt in the database, not in memory',t=>{
  const {team,a,create}=fixture(t),x=create('x')
  team.claim(x.id,'worker-x')
  assert.equal(team.recordStep('worker-x',3).steps,1)
  assert.equal(team.recordStep('worker-x',3).steps,2)
  team.recordTokens('worker-x',120)
  assert.deepEqual(team.usage(x.id),{steps:2,tokens:120,tokensReported:true,attempts:1,note:null})
  assert.equal(team.recordStep('worker-x',3).steps,3)
  assert.throws(()=>team.recordStep('worker-x',3),/预算/)
  assert.throws(()=>team.recordTokens('worker-x',-1),/用量/)
  assert.throws(()=>team.recordTokens('worker-y',10),/授权/)
  // The counters are durable: a fresh store over the same database agrees.
  const reopened=new TeamStore(team.social)
  assert.deepEqual(reopened.usage(x.id),{steps:3,tokens:120,tokensReported:true,attempts:1,note:null})
  assert.equal(reopened.overview().find(row=>row.id===x.id).steps,3)
  assert.equal(JSON.stringify(reopened.overview()).includes('secret'),false)
  // A second attempt keeps its own row instead of resetting the first.
  team.finish('worker-x')
  team.db.prepare("UPDATE yoyo_team_tasks SET state='ready' WHERE id=?").run(x.id)
  team.claim(x.id,'worker-x2')
  assert.equal(team.recordStep('worker-x2',3).steps,1)
  assert.equal(team.usage(x.id).tokens,120)
  assert.equal(team.usage(x.id).attempts,2)
})

test('missing token reporting is kept apart from a measured zero',t=>{
  const {team,a,create}=fixture(t),x=create('x')
  team.claim(x.id,'worker-x')
  team.recordStep('worker-x',3)
  // The runtime does not report usage at all: the ledger must not look free.
  assert.deepEqual(team.recordTokens('worker-x',0,false),{tokens:0,reported:false})
  const unknown=team.usage(x.id)
  assert.equal(unknown.tokens,0)
  assert.equal(unknown.tokensReported,false)
  assert.match(unknown.note,/未测量/)
  // A later real report flips the flag and the note disappears.
  team.recordTokens('worker-x',900,true)
  const measured=team.usage(x.id)
  assert.equal(measured.tokens,900)
  assert.equal(measured.tokensReported,true)
  assert.equal(measured.note,null)
  // A reported zero cannot be told apart from "no interface", so it stays marked
  // as unmeasured instead of pretending we counted zero tokens.
  assert.equal(team.recordTokens('worker-x',0,true).reported,false)
  // Databases created before the flag existed gain the column on open.
  team.db.exec('ALTER TABLE yoyo_team_usage RENAME TO legacy_usage')
  team.db.exec('CREATE TABLE yoyo_team_usage(task_id TEXT NOT NULL,attempt INTEGER NOT NULL,steps INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(task_id,attempt))')
  team.db.prepare('INSERT INTO yoyo_team_usage VALUES(?,0,2,55,?)').run(x.id,Date.now())
  const upgraded=new TeamStore(team.social)
  assert.equal(upgraded.db.prepare('PRAGMA table_info(yoyo_team_usage)').all().some(column=>column.name==='tokens_reported'),true)
  // A positive count from before the flag existed did come from a real report.
  assert.deepEqual(upgraded.usage(x.id),{steps:2,tokens:55,tokensReported:true,attempts:1,note:null})
})

test('a lease heartbeat renews within a ceiling and retries stay bounded',t=>{
  const {team,a,create}=fixture(t),x=create('x')
  team.claim(x.id,'worker-x')
  assert.equal(team.renew('worker-x',600000).expiresAt,600100)
  assert.equal(team.renew('worker-x',3600000*5).expiresAt,3600100,'the heartbeat is capped')
  team.finish('worker-x')
  assert.throws(()=>team.renew('worker-x'),/授权/)
  assert.throws(()=>team.noteFailure(x.id,{maxAttempts:2}),/已完成或已取消/)
  // A blocked task is retried only inside the configured allowance.
  team.db.prepare("UPDATE yoyo_team_tasks SET state='blocked' WHERE id=?").run(x.id)
  assert.deepEqual(team.noteFailure(x.id,{maxAttempts:2,backoffMs:0,now:100}),{failures:1,retryAt:100})
  assert.equal(team.resumable({now:100}).length,1)
  assert.equal(team.requeue(x.id),true)
  assert.equal(team.inspect(x.id,a.id).state,'ready')
  assert.equal(team.resumable({now:100}).length,0)
  team.db.prepare("UPDATE yoyo_team_tasks SET state='blocked' WHERE id=?").run(x.id)
  assert.equal(team.noteFailure(x.id,{maxAttempts:2,backoffMs:0,now:100}).retryAt,null,'the second failure exhausts the allowance')
  assert.equal(team.resumable({now:100}).length,0)
  assert.equal(team.requeue(x.id),false)
})

test('a retried task keeps the same executor identity so its native session can resume',async t=>{
  const {team,a,create}=fixture(t),x=create('x')
  const coordinator=new TeamCoordinator({tasks:team,adapter:{async run(){}},tools:{step:async()=>({allowed:true})}})
  const first=coordinator.start(x.id)
  assert.match(first.agentId,/^worker-[a-f0-9]{20}$/)
  await coordinator.settle(x.id)
  assert.equal(team.inspect(x.id,a.id).state,'completed')
  team.db.prepare("UPDATE yoyo_team_tasks SET state='ready' WHERE id=?").run(x.id)
  const second=coordinator.start(x.id)
  assert.equal(second.agentId,first.agentId,'the same worker home and session id')
  await coordinator.settle(x.id)
  assert.equal(team.inspect(x.id,a.id).attempt,2)
})

test('roles differ in whether they may speak, and a task can only narrow its own tools',t=>{
  const {team,social,a,create}=fixture(t)
  const reader=team.create({key:'reader',role:'reader',goal:'读一遍这段对话并概括',viewId:a.id,expiresAt:1000})
  assert.equal(reader.authorization_version,social.target(a.focus).version)
  assert.equal(reader.depends_on,null)
  // A reader takes no speaker lease; the window stays available.
  team.claim(reader.id,'reader-1')
  assert.equal(team.db.prepare('SELECT count(*) n FROM yoyo_team_speakers').get().n,0)
  team.finish('reader-1')
  const verify=team.create({key:'verify',role:'verify',goal:'核对证据',viewId:a.id,expiresAt:1000})
  assert.equal(verify.authorization_version,null)
  assert.throws(()=>team.create({key:'narrow',role:'verify',goal:'g',viewId:a.id,expiresAt:1000,toolset:['send']}),/工具集/)
  const narrowed=team.create({key:'narrow-ok',role:'chat',goal:'g',viewId:a.id,expiresAt:1000,toolset:['read','report']})
  assert.deepEqual(JSON.parse(narrowed.toolset),['read','report'])
  assert.throws(()=>team.create({key:'bad-role',role:'admin',goal:'g',viewId:a.id,expiresAt:1000}),/角色/)
  assert.throws(()=>team.create({key:'no-focus',role:'reader',goal:'g',viewId:social.planningView().id,expiresAt:1000}),/绑定窗口/)
  // An authorisation change invalidates a task created under the old version.
  const stale=team.create({key:'stale',role:'chat',goal:'g',viewId:a.id,expiresAt:1000})
  social.approve(a.focus,false);social.approve(a.focus,true)
  assert.throws(()=>team.claim(stale.id,'worker-stale'),/授权/)
  // A task created from the current view carries the current version and runs.
  const reopened=social.open(a.focus)
  const fresh=team.create({key:'fresh',role:'chat',goal:'g',viewId:reopened.id,expiresAt:1000})
  assert.equal(fresh.authorization_version,social.target(a.focus).version)
  team.claim(fresh.id,'worker-fresh')
})

test('a dependent task cannot be claimed or started before its dependency completes',t=>{
  const {team,a,create}=fixture(t),first=create('first')
  const second=team.create({key:'second',role:'reader',goal:'g',viewId:a.id,expiresAt:1000,dependsOn:[first.id]})
  assert.throws(()=>team.claim(second.id,'worker-2'),/依赖/)
  team.claim(first.id,'worker-1');team.finish('worker-1')
  team.claim(second.id,'worker-2')
  assert.equal(team.authority('worker-2').task.state,'running')
})
