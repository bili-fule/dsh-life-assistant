import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { Motivation } from '../src/motivation.mjs'
import { TeamHost } from '../src/team-host.mjs'

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'yoyo-motivation-')),store=new Store(join(dir,'data.sqlite')),data=new SocialStore(store)
  const motivation=new Motivation(data)
  const target=peer=>{const t=data.discover({platform:'qq',account:'10001',kind:'private',peer});return data.approve(t.handle,true)}
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  const message=(handle,sender,externalId,text)=>({handle,id:data.ingest({target:handle,sender,externalId,text}).id})
  return {store,data,motivation,target,message}
}
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<0.02,label+': '+actual+' ≈ '+expected)

test('expectation, experience and preference are separate and only real events count',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),view=data.open(a.handle),msg=message(a.handle,'123','first','这段讨论挺有意思')
  const choice=motivation.choose(view.id,{activity:'接着聊这个话题',context:'熟悉的人闲聊',chosen:'接着聊',reason:'想知道他怎么想',
    candidates:[{label:'接着聊',appeal:'high',expectedPleasure:'high',expectedSatisfaction:'medium',effort:'low'},{label:'休息',appeal:'low'}]})
  assert.equal(choice.kind,'activity')
  assert.equal(choice.expected.pleasure,'high')
  assert.equal(motivation.options(view.id,{activity:'接着聊这个话题'}).current.id,choice.id)
  const result=motivation.appraise(view.id,{choice:choice.id,outcome:'聊到有意思的分歧',liked:'liked',worthAfter:'worth',progress:'yes',
    explanation:'被认真回应了',confidence:'medium',evidence:{messages:[msg.id]}})
  assert.equal(result.credit,'observed')
  assert.equal(result.evidence,'message')
  near(result.preference.liking,0.18,'first liking')
  assert.equal(result.preference.samples,1)
  assert.equal(result.preference.stable,false)
  assert.equal(result.affect.mood,'calm')
  // Wanting is stored next to liking but learned separately from the expectation error.
  const stored=motivation.preferenceList(data.view(view.id))[0]
  assert.notEqual(stored.wanting,stored.liking)
  assert.equal(stored.evidence.length,1)
  // No writable total happiness score exists.
  assert.equal(typeof motivation.setHappiness,'undefined')
})

test('the same real event is counted once even when it is replayed or reported twice',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),view=data.open(a.handle),msg=message(a.handle,'123','dup','又来找我')
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('run-1','yoyo_search',JSON.stringify(view.scopes),'same results',Date.now())
  const choice=motivation.choose(view.id,{activity:'查资料',chosen:'查资料'})
  const payload={choice:choice.id,outcome:'只找到相同的资料',liked:'neutral',worthAfter:'unsure',progress:'no',evidence:{messages:[msg.id],receipts:['run-1']}}
  const first=motivation.appraise(view.id,payload)
  assert.equal(first.duplicate,false)
  const replay=motivation.appraise(view.id,payload)
  assert.equal(replay.duplicate,true)
  assert.equal(motivation.preferenceList(data.view(view.id))[0].samples,1)
  const another=motivation.choose(view.id,{activity:'查资料',chosen:'查资料'})
  // A second executor reporting the same material is still the same event.
  assert.equal(motivation.appraise(view.id,{...payload,choice:another.id}).duplicate,true)
  assert.equal(data.db.prepare('SELECT count(*) n FROM yoyo_motivation_experiences').get().n,1)
})

test('one unpleasant experience cannot make an activity permanently disliked',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),view=data.open(a.handle)
  const events=[]
  for(const n of [1,2,3])events.push(message(a.handle,'123','neg-'+n,'重复争论第'+n+'轮').id)
  const run=(msg,liked)=>motivation.appraise(view.id,{choice:motivation.choose(view.id,{activity:'和这个群争论',chosen:'争论',rest:false}).id,
    outcome:'又在原地争论',liked,worthAfter:'not_worth',progress:'no',evidence:{messages:[msg]},confidence:'medium'})
  const first=run(events[0],'disliked')
  assert.equal(first.revision.state,'applied')
  assert.ok(first.preference.liking>=-0.25,'a single bad turn stays mild')
  assert.equal(first.preference.stable,false)
  const second=run(events[1],'disliked')
  assert.equal(second.preference.stable,false)
  const third=run(events[2],'disliked')
  assert.equal(third.preference.stable,true)
  assert.ok(third.preference.liking<=-0.4)
})

test('activities keep their own record of how they went, without one happiness score',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),b=target('456'),view=data.open(a.handle),other=data.open(b.handle)
  const run=(activity,liked,worth,msg,extra={})=>motivation.appraise(view.id,{choice:motivation.choose(view.id,{activity,chosen:activity}).id,
    outcome:activity+' 的一次',liked,worthAfter:worth,progress:'unknown',evidence:{messages:[msg]},confidence:'medium',...extra})
  const talk=message(a.handle,'123','act-1','聊得挺开心').id
  const read=message(a.handle,'123','act-2','这篇文章不错').id
  run('和他闲聊','liked','worth',talk)
  run('和他闲聊','neutral','unsure',talk)
  run('读技术文章','disliked','not_worth',read)
  const summary=motivation.activitySummary(data.view(view.id))
  const chat=summary.find(entry=>entry.activity==='和他闲聊')
  assert.equal(chat.encounters,2)
  assert.equal(chat.liked,1)
  assert.equal(chat.neutral,1)
  assert.equal(chat.worth,1)
  assert.equal(chat.unsure,1)
  const reading=summary.find(entry=>entry.activity==='读技术文章')
  assert.equal(reading.disliked,1)
  assert.equal(reading.notWorth,1)
  // The compact dynamic state carries the same counts, and nothing is merged
  // into a single writable happiness number.
  assert.equal(motivation.summary(data.view(view.id)).activities.length,2)
  assert.deepEqual(motivation.activitySummary(data.view(other.id)),[],'counts never leak into another window')
  assert.equal(typeof motivation.happiness,'undefined')
})

test('private experience never changes public or other-window affect and preferences',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),b=target('456'),privateView=data.open(a.handle),other=data.open(b.handle),publicView=data.publicView(),msg=message(a.handle,'123','priv','只对你说的')
  const choice=motivation.choose(privateView.id,{activity:'听他说烦心事',chosen:'听他说'})
  motivation.appraise(privateView.id,{choice:choice.id,outcome:'听完有点沉重',liked:'disliked',worthAfter:'worth',evidence:{messages:[msg.id]},confidence:'high'})
  const privateState=motivation.options(privateView.id)
  assert.equal(privateState.preferences.length,1)
  assert.equal(motivation.options(publicView.id).preferences.length,0)
  assert.equal(motivation.options(other.id).preferences.length,0)
  assert.equal(motivation.options(publicView.id).affect.source,'none')
  assert.equal(motivation.options(other.id).affect.mood,'calm')
  // A choice made in one window cannot be appraised from another.
  assert.throws(()=>motivation.appraise(other.id,{choice:choice.id,outcome:'猜测',liked:'neutral'}),/资料范围/)
  // Appraising from a broader view keeps the private scope on the new record.
  const planning=data.planningView()
  motivation.appraise(planning.id,{choice:choice.id,outcome:'回看仍然沉重',liked:'disliked',confidence:'high'})
  assert.equal(motivation.options(publicView.id).preferences.length,0)
  assert.ok(motivation.options(planning.id).preferences.length>=1)
})

test('repeated identical content loses continued value while new material restores it',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),view=data.open(a.handle)
  const ids=[1,2,3].map(n=>message(a.handle,'123','sat-'+n,'同样的资料'+n).id)
  const appraise=(msg,repeatKey,liked='neutral')=>motivation.appraise(view.id,{choice:motivation.choose(view.id,{activity:'搜同一主题',chosen:'搜索'}).id,
    outcome:'还是那几份资料',liked,worthAfter:'unsure',repeatKey,evidence:{messages:[msg]}})
  assert.equal(appraise(ids[0],'results-a').affect.continuedValue,0.8)
  assert.equal(appraise(ids[1],'results-a').affect.continuedValue,0.6)
  const fresh=appraise(ids[2],'results-b','liked')
  assert.equal(fresh.affect.continuedValue,0.8)
  near(fresh.revision.change.liking,0.18,'new material is not discounted')
  const repeat=motivation.options(view.id,{activity:'搜同一主题'}).repeat
  assert.equal(repeat[0].repeatKey,'results-b')
  assert.equal(repeat[0].count,1)
})

test('worker claims and self-authored notebooks cannot raise satisfaction',t=>{
  const {data,motivation,target}=fixture(t),a=target('123'),view=data.open(a.handle)
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('inspect-1','team_inspect',JSON.stringify(view.scopes),'{"report":"一切顺利"}',Date.now())
  data.db.prepare('INSERT INTO yoyo_tool_sources VALUES(?,?,?,?,?)').run('concern-1','yoyo_concern',JSON.stringify(view.scopes),'我很满足',Date.now())
  const choice=motivation.choose(view.id,{activity:'让执行者研究',chosen:'研究'})
  const worker=motivation.appraise(view.id,{choice:choice.id,outcome:'执行者说很成功',liked:'liked',progress:'yes',evidence:{receipts:['inspect-1']}})
  assert.equal(worker.credit,'unverified')
  assert.equal(worker.evidence,'worker_report')
  assert.equal(worker.preference,null)
  const selfReport=motivation.appraise(view.id,{choice:choice.id,outcome:'我自己觉得很好',liked:'liked',progress:'yes',evidence:{receipts:['concern-1']}})
  assert.equal(selfReport.credit,'unverified')
  assert.equal(selfReport.evidence,'self_report')
  assert.equal(motivation.options(view.id).preferences.length,0)
  // The experience is still recorded for later review and cannot be replayed for credit.
  assert.equal(motivation.options(view.id).recent.length,2)
  assert.equal(motivation.options(view.id).recent[0].credit,'unverified')
})

test('rest is a complete candidate and looking around creates no work',t=>{
  const {data,motivation,target}=fixture(t),a=target('123'),view=data.open(a.handle)
  const before={choices:data.db.prepare('SELECT count(*) n FROM yoyo_motivation_choices').get().n,
    concerns:data.db.prepare('SELECT count(*) n FROM yoyo_concerns').get().n,plans:data.db.prepare('SELECT count(*) n FROM yoyo_plans').get().n}
  for(const _ of [1,2,3])motivation.options(view.id)
  assert.equal(motivation.options(view.id).current,null)
  const rest=motivation.choose(view.id,{activity:'休息',chosen:'休息',rest:true,reason:'现在没有值得做的事',returnWhen:'有新消息时再看'})
  assert.equal(rest.kind,'rest')
  assert.equal(rest.returnWhen,'有新消息时再看')
  motivation.appraise(view.id,{choice:rest.id,outcome:'安静待了一会儿',liked:'neutral',worthAfter:'worth',end:true})
  const after={choices:data.db.prepare('SELECT count(*) n FROM yoyo_motivation_choices').get().n,
    concerns:data.db.prepare('SELECT count(*) n FROM yoyo_concerns').get().n,plans:data.db.prepare('SELECT count(*) n FROM yoyo_plans').get().n}
  assert.equal(after.choices,before.choices+1)
  assert.equal(after.concerns,before.concerns)
  assert.equal(after.plans,before.plans)
  assert.equal(motivation.openChoices(data.view(view.id)).length,0)
})

test('a contrary experience on a stable preference needs explicit confirmation and can be reverted',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),view=data.open(a.handle)
  const ids=[1,2,3].map(n=>message(a.handle,'123','stable-'+n,'继续写项目'+n).id)
  const run=(msg,liked)=>motivation.appraise(view.id,{choice:motivation.choose(view.id,{activity:'写自己的项目',chosen:'继续写'}).id,
    outcome:'写完一段',liked,worthAfter:'worth',progress:'yes',evidence:{messages:[msg]},confidence:'medium'})
  for(const id of ids)run(id,'liked')
  const stable=motivation.preferenceList(data.view(view.id))[0]
  assert.equal(stable.stable,true)
  near(stable.liking,0.54,'three consistent experiences')
  const contrary=message(a.handle,'123','stable-bad','项目卡住了').id
  const proposal=run(contrary,'disliked')
  assert.equal(proposal.revision.state,'proposed')
  assert.equal(proposal.preference,null)
  assert.equal(motivation.preferenceList(data.view(view.id))[0].liking,stable.liking)
  const pending=motivation.proposals(data.view(view.id))
  assert.equal(pending.length,1)
  assert.ok(pending[0].change.liking<0)
  const applied=motivation.preferences(view.id,{revision:pending[0].id,decision:'apply',reason:'确实开始难受了'})
  assert.equal(applied.state,'applied')
  assert.ok(applied.liking<stable.liking)
  const reverted=motivation.preferences(view.id,{revert:applied.id,reason:'那次只是临时状态'})
  assert.equal(reverted.state,'reverted')
  near(reverted.liking,stable.liking,'revert restores the previous value')
  // A rejected proposal leaves the preference untouched.
  const again=run(message(a.handle,'123','stable-bad-2','又卡住').id,'disliked')
  assert.equal(again.revision.state,'proposed')
  motivation.preferences(view.id,{revision:again.revision.id,decision:'reject',reason:'这次不算'})
  near(motivation.preferenceList(data.view(view.id))[0].liking,stable.liking,'rejection keeps the old value')
})

test('manual preference revision is bounded and needs a genuine experience',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),view=data.open(a.handle),msg=message(a.handle,'123','manual','聊得很好')
  const choice=motivation.choose(view.id,{activity:'和人闲聊',chosen:'聊'})
  const result=motivation.appraise(view.id,{choice:choice.id,outcome:'聊得不错',liked:'liked',worthAfter:'worth',evidence:{messages:[msg.id]},confidence:'low'})
  assert.throws(()=>motivation.preferences(view.id,{activity:'和人闲聊',liking:1}),/实际经历/)
  const revised=motivation.preferences(view.id,{activity:'和人闲聊',liking:1,evidence:[result.experience],reason:'确实喜欢'})
  near(revised.preference.liking,0.21,'one manual step only moves by 0.12')
  assert.throws(()=>motivation.preferences(view.id,{activity:'和人闲聊',liking:1,evidence:[result.experience]}),/已经用于/)
  const list=motivation.preferences(view.id)
  assert.equal(list.revisions.length,2)
  assert.ok(list.revisions.every(r=>['applied','proposed','withheld','rejected','reverted'].includes(r.state)))
})

test('a delegation may belong to one of the subject’s own choices but never to a retired or foreign one',async t=>{
  const {store,data,motivation,target}=fixture(t),a=target('123'),b=target('456'),view=data.open(a.handle)
  const host=new TeamHost({store,data,separate:true,sessionId:'main',qq:null,motivation},{})
  t.after(async()=>{await host.stop()})
  const concern=data.concern(view.id,{title:'弄清这个问题',why:'好奇',origin:'刚才的讨论',next:'查资料',doneWhen:'有解释',stopWhen:'没有进展'})
  const choice=motivation.choose(view.id,{activity:'一起研究这个问题',chosen:'研究'})
  const delegate=over=>host.motivation.delegate({concernId:concern.id,rationale:'想弄清楚',role:'chat',goal:'聊这个话题',viewId:view.id,expiresAt:Date.now()+60000,...over})
  const task=delegate({choiceId:choice.id,key:'run-1'})
  assert.equal(data.db.prepare('SELECT choice_id FROM yoyo_team_intents WHERE task_id=?').get(task.id).choice_id,choice.id)
  assert.equal(host.motivation.deliberate(view.id).work[0].choice.id,choice.id)
  const foreign=motivation.choose(data.open(b.handle).id,{activity:'别的事',chosen:'做'})
  assert.throws(()=>delegate({choiceId:foreign.id,key:'run-2'}),/不在当前资料范围/)
  motivation.appraise(view.id,{choice:choice.id,outcome:'告一段落',liked:'neutral',end:true})
  assert.throws(()=>delegate({choiceId:choice.id,key:'run-3'}),/已结束/)
  // Delegation without a motivation layer keeps working unchanged.
  const plain=new TeamHost({store,data,separate:true,sessionId:'main',qq:null},{})
  t.after(async()=>{await plain.stop()})
  const plainTask=plain.motivation.delegate({concernId:concern.id,rationale:'沿用原流程',role:'chat',goal:'聊这个话题',viewId:view.id,expiresAt:Date.now()+60000,key:'run-4'})
  assert.equal(data.db.prepare('SELECT choice_id FROM yoyo_team_intents WHERE task_id=?').get(plainTask.id).choice_id,null)
  assert.throws(()=>plain.motivation.delegate({concernId:concern.id,choiceId:choice.id,rationale:'没有动机层',role:'chat',goal:'x',viewId:view.id,expiresAt:Date.now()+60000,key:'run-5'}),/动机层未启用/)
  const linked=motivation.choose(view.id,{activity:'继续写自己的项目',chosen:'写',concern:concern.id})
  assert.equal(motivation.openChoice(data.view(view.id),linked.id).concern,concern.id)
  assert.throws(()=>motivation.choose(view.id,{activity:'别的事',chosen:'做',concern:9999}),/不在当前资料范围/)
})

test('a later review keeps the original experience and proposes a correction instead of replaying it',t=>{
  const {data,motivation,target,message}=fixture(t),a=target('123'),view=data.open(a.handle),msg=message(a.handle,'123','later','看完了')
  const choice=motivation.choose(view.id,{activity:'看一个长视频',chosen:'看完'})
  const first=motivation.appraise(view.id,{choice:choice.id,outcome:'看得挺开心',liked:'liked',worthAfter:'worth',evidence:{messages:[msg.id]},confidence:'medium'})
  const late=motivation.appraise(view.id,{choice:choice.id,outcome:'过一会儿觉得浪费时间',liked:'neutral',worthAfter:'not_worth',laterOf:first.experience,evidence:{messages:[msg.id]},confidence:'medium'})
  assert.equal(late.later,true)
  assert.equal(late.duplicate,false)
  assert.equal(late.revision.state,'proposed')
  const records=data.db.prepare('SELECT body FROM yoyo_motivation_experiences ORDER BY id').all().map(r=>JSON.parse(r.body))
  assert.equal(records.length,2)
  assert.equal(records[0].later.worth,'not_worth')
  assert.equal(records[1].later.of,first.experience)
  assert.equal(motivation.preferenceList(data.view(view.id))[0].samples,1,'the later review does not inflate the sample count')
})
