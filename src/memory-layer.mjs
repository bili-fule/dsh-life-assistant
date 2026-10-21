import { createHash } from 'node:crypto'
import { boundedText,mayRead,sourceScopes } from './scope.mjs'

// Phase 1 of the humanlike memory plan: keep the source, the claim and the
// derivation chain apart, so a summary can never become a new fact, a retracted
// experience can never be re-derived from the same messages, and a forwarded
// name can never become an identity. Nothing here decides what the subject
// feels; it only records what happened and where it came from.
export const MEMORY_TOOLS=['memory_recall','memory_inspect','memory_propose','memory_retract','memory_segments','memory_intent','memory_generalize']
export const MEMORY_POLICY=`你可以用 memory_recall 按线索想起当前范围内相关的经历与主张，用 memory_inspect 核对原始依据，用 memory_propose 提交带来源的经历或主张，用 memory_retract 淡出、归档、撤回或按要求忘记。概括不是新的事实来源：同一条原文反复引用仍然只算一个来源，推断不会被重复回忆升级为观察。转发里的姓名和引自他人的说法不能当作本人身份或本人偏好；同昵称的两个人按平台、账号和真实发送者编号区分。执行者说查过但没有工具依据的，只能记成报告。被撤回或要求忘记的来源不能再重新形成记忆。记下的承诺与等待由宿主在真实触发时提醒一次；连续多次没有被理会的事项会安静下来，不要靠反复提醒撑住注意力。`

const CLAIM_KINDS=['fact','knowledge','preference','impression','communication','procedure','self','simulation']
const CONFIDENCE=['observed','told','worker_report','inference','self_report']
const ROLES=['participant','observer','worker_report','told']
const PERSON_KINDS=['preference','impression','communication']
// A preference may be about a topic; an impression or a communication habit is
// always about one stable person.
const PERSON_REQUIRED=['impression','communication']
const INTENT_KINDS=['commitment','intention','waiting']
const INTENT_TRIGGERS=['time','window','explicit']
// A reminder that keeps firing without ever being acted on or dropped is noise.
// After this many ignored wakes the window trigger stays quiet until the subject
// closes, rewrites or explicitly asks for it again.
const NAG_LIMIT=3
const IMPRESSION_DIMENSIONS=['familiarity','trust','liking','admiration','imitation']
// Receipts from the agent's own records can never prove that something was done.
const SELF_TOOLS=new Set(['yoyo_memory','yoyo_forget','yoyo_recall','yoyo_evidence','yoyo_self','yoyo_sleep','yoyo_wait','yoyo_learning','yoyo_concern','yoyo_feedback','yoyo_plan','yoyo_activity','life_context','self_options','self_choose','self_appraise','self_preferences','memory_recall','memory_inspect','memory_propose','memory_retract','memory_segments','memory_intent','memory_generalize'])
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value))
const keyOf=text=>text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'')
function option(value,list,label,fallback) {
  if(value===undefined||value===null){if(fallback===undefined)throw Error('需要'+label);return fallback}
  if(!list.includes(value))throw Error(label+'无效')
  return value
}
function optionalText(value,max,label) {return value===undefined||value===null||value===''?'':boundedText(value,max,label)}
// A clue rarely arrives in the same words. Terms plus two-character CJK
// fragments let "上次那部电影的镜头" reach a record stored as "电影里的长镜头";
// real synonyms still need an embedding index, which is a later phase.
function terms(query) {
  const found=new Set()
  for(const word of String(query).toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(word=>word.length>1)){
    found.add(word)
    if(word.length>=4&&/[\u4e00-\u9fff]/.test(word))
      for(let index=0;index+2<=word.length&&found.size<24;index++)found.add(word.slice(index,index+2))
  }
  return [...found].slice(0,24)
}

export class MemoryLayer {
  constructor(data,config={}) {
    this.data=data;this.db=data.db
    // A recall returns summaries and citations only; the original text needs
    // memory_inspect so that a plausible summary cannot silently replace it.
    this.recallLimit=clamp(Number.isFinite(config.recallLimit)?config.recallLimit:8,1,20)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_memory_episodes(
        id INTEGER PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,
        occurred_from INTEGER,occurred_to INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_memory_claims(
        id INTEGER PRIMARY KEY,subject TEXT NOT NULL,kind TEXT NOT NULL,statement TEXT NOT NULL,
        body TEXT NOT NULL,scopes TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
        confidence TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,episode_id INTEGER,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_memory_links(
        id INTEGER PRIMARY KEY,from_kind TEXT NOT NULL,from_id INTEGER NOT NULL,
        to_kind TEXT NOT NULL,to_id INTEGER NOT NULL,relation TEXT NOT NULL,created_at INTEGER NOT NULL,
        UNIQUE(from_kind,from_id,to_kind,to_id,relation));
      CREATE TABLE IF NOT EXISTS yoyo_memory_revisions(
        id INTEGER PRIMARY KEY,claim_id INTEGER NOT NULL,before TEXT,after TEXT NOT NULL,
        basis TEXT NOT NULL,confidence TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_memory_retractions(
        id INTEGER PRIMARY KEY,kind TEXT NOT NULL,ref TEXT NOT NULL,reason TEXT NOT NULL,
        scopes TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(kind,ref));
      CREATE TABLE IF NOT EXISTS yoyo_memory_uses(
        id INTEGER PRIMARY KEY,kind TEXT NOT NULL,ref_id INTEGER NOT NULL,clue TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_memory_intents(
        id INTEGER PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',due_at INTEGER,consumed_at INTEGER,consumed_ref INTEGER,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_memory_migrations(
        legacy_id INTEGER PRIMARY KEY,claim_id INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_memory_wakes(
        id INTEGER PRIMARY KEY,intent_id INTEGER NOT NULL,view_id TEXT NOT NULL,reason TEXT NOT NULL,
        outcome TEXT,created_at INTEGER NOT NULL,resolved_at INTEGER);
    `)
    // Off by default: importing old notes is a deliberate operation.
    if(config.migrateLegacy===true)this.legacyMigration=this.migrateLegacy()
  }
  visible(alias) {return `NOT EXISTS(SELECT 1 FROM json_each(${alias}.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?)))`}

  // ---- evidence ----------------------------------------------------------
  evidence(view,args={}) {
    const refs=[]
    const messages=[...(args.messages??[])]
    // A candidate segment can be cited as a range: the host expands it to the
    // actual messages so the model never has to list forty ids by hand.
    if(args.range!==undefined&&args.range!==null){
      const {from,to}=args.range
      if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1||to<from||to-from>39)throw Error('分段范围无效（最多 40 条）')
      if(!view.focus)throw Error('按范围引用来源需要绑定一个窗口')
      for(const row of this.db.prepare('SELECT id FROM yoyo_events WHERE target=? AND id>=? AND id<=? ORDER BY id LIMIT 40').all(view.focus,from,to))messages.push(row.id)
      if(!messages.length)throw Error('该范围内没有可引用的原文')
    }
    for(const id of messages){
      if(!Number.isSafeInteger(id)||id<1)throw Error('消息来源编号无效')
      const row=this.db.prepare('SELECT id,scope,sender,target,segments,kind,received_at,text FROM yoyo_events WHERE id=?').get(id)
      if(!row||!mayRead(view,row.scope))throw Error('消息来源不在当前资料范围')
      refs.push({type:'event',id:row.id,scope:row.scope,sender:row.sender,target:row.target,
        forward:JSON.parse(row.segments).some(segment=>segment.type==='forward'),outgoing:row.kind==='outgoing',at:row.received_at,key:'event:'+row.id})
    }
    for(const key of args.receipts??[]){
      if(typeof key!=='string'||!key)throw Error('工具回执编号无效')
      const row=this.db.prepare('SELECT run_key,name,scopes,result_text FROM yoyo_tool_sources WHERE run_key=?').get(key)
      if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('工具回执不在当前资料范围')
      refs.push({type:'receipt',id:row.run_key,name:row.name,scope:JSON.parse(row.scopes),key:'receipt:'+row.run_key})
    }
    for(const id of args.documents??[]){
      if(!Number.isSafeInteger(id)||id<1)throw Error('网页来源编号无效')
      const row=this.db.prepare('SELECT id,url,body,scope FROM yoyo_documents WHERE id=?').get(id)
      if(!row||!mayRead(view,row.scope))throw Error('网页来源不在当前资料范围')
      refs.push({type:'document',id:row.id,url:row.url,scope:row.scope,key:'document:'+row.id})
    }
    for(const ref of refs){
      if(this.db.prepare("SELECT 1 FROM yoyo_memory_retractions WHERE kind='source' AND ref=?").get(ref.key))
        throw Error('这条来源已被要求忘记，不能重新形成记忆')
    }
    const unique=new Map();for(const ref of refs)unique.set(ref.key,ref)
    return [...unique.values()].slice(0,10)
  }
  person(view,messages) {
    const source=this.evidence(view,{messages})
    if(source.length<1)throw Error('关于人的记忆需要至少一条直接原文')
    const events=source.filter(ref=>ref.type==='event')
    if(!events.length)throw Error('关于人的记忆需要直接的聊天原文，不能用工具回执代替身份')
    if(events.some(ref=>ref.forward))throw Error('转发内容是引文，不能作为本人身份或本人偏好的依据')
    if(events.some(ref=>ref.outgoing))throw Error('自己发出的消息不能作为对方的身份依据')
    const identities=new Set()
    for(const ref of events){
      const target=this.db.prepare('SELECT platform,account FROM yoyo_targets WHERE handle=?').get(ref.target)
      if(!target)throw Error('消息窗口不存在')
      identities.add(JSON.stringify([target.platform,target.account,ref.sender]))
    }
    if(identities.size!==1)throw Error('一条记忆只能指向同一个稳定身份，不能混合不同的人')
    const [platform,account,sender]=JSON.parse([...identities][0])
    return {identity:'person:'+platform+':'+account+':'+sender,platform,account,sender,messages:events.length,evidence:source}
  }

  // ---- proposing ---------------------------------------------------------
  propose(viewId,args) {
    const view=this.data.view(viewId)
    const kind=option(args.kind,['episode','claim'],'记忆对象',null)
    if(kind==='episode')return this.proposeEpisode(view,args)
    return this.proposeClaim(view,args)
  }
  proposeEpisode(view,args) {
    const title=boundedText(args.title,200,'经历标题')
    const sources=this.evidence(view,args.evidence??{})
    if(!sources.length)throw Error('经历需要至少一条当前可见的原文、回执或网页来源')
    const role=option(args.role,ROLES,'自己的角色','participant')
    const participants=[]
    for(const ref of sources.filter(item=>item.type==='event')){
      if(participants.some(person=>person.target===ref.target&&person.sender===ref.sender))continue
      if(participants.length>=8)break
      const target=this.db.prepare('SELECT label,kind FROM yoyo_targets WHERE handle=?').get(ref.target)
      participants.push({target:ref.target,sender:ref.sender,label:target?.label??'',window:target?.kind??''})
    }
    if(!participants.length&&role!=='worker_report')throw Error('情景记忆需要真实的聊天参与者；只有执行者报告时请用 worker_report 角色')
    const times=sources.filter(ref=>ref.type==='event').map(ref=>ref.at)
    const occurredFrom=args.occurredFrom??(times.length?Math.min(...times):null)
    const occurredTo=args.occurredTo??(times.length?Math.max(...times):null)
    for(const [value,label] of [[occurredFrom,'开始时间'],[occurredTo,'结束时间']])
      if(value!==null&&value!==undefined&&(!Number.isSafeInteger(value)||value<0))throw Error(label+'无效')
    const body={scene:optionalText(args.scene,500,'场景'),role,
      what:boundedText(args.what,2000,'发生了什么'),
      turningPoint:optionalText(args.turningPoint,1000,'关键转折'),
      outcome:optionalText(args.outcome,1000,'实际结果'),
      unresolved:optionalText(args.unresolved,1000,'未解决事项'),
      expectation:optionalText(args.expectation,1000,'当时的期待'),
      appraisal:optionalText(args.appraisal,1000,'当时的评价'),
      laterAppraisal:optionalText(args.laterAppraisal,1000,'稍后的重新评价'),
      note:optionalText(args.note,500,'补充'),
      participants,sources:sources.map(ref=>({type:ref.type,id:ref.id,key:ref.key}))}
    const scopes=sourceScopes([...view.scopes,...sources.flatMap(ref=>Array.isArray(ref.scope)?ref.scope:[ref.scope])])
    const signature=createHash('sha256').update(JSON.stringify(['episode',keyOf(title),sources.map(ref=>ref.key).sort()])).digest('hex')
    const existing=this.db.prepare(`SELECT e.id,e.body FROM yoyo_memory_episodes e WHERE e.status<>'retracted' AND ${this.visible('e')} ORDER BY e.id DESC LIMIT 300`)
      .all(JSON.stringify(view.scopes)).find(row=>JSON.parse(row.body).signature===signature)
    if(existing)return {duplicate:true,id:existing.id,message:'同一来源和同一段经历已经记录，不重复计入'}
    const now=Date.now()
    return this.data.store.transaction(()=>{
      const id=Number(this.db.prepare('INSERT INTO yoyo_memory_episodes(title,body,scopes,status,version,occurred_from,occurred_to,created_at,updated_at) VALUES(?,?,?,\'active\',1,?,?,?,?)')
        .run(title,JSON.stringify({...body,signature}),JSON.stringify(scopes),occurredFrom??null,occurredTo??null,now,now).lastInsertRowid)
      for(const person of participants)this.link('episode',id,'entity',hashIdentity(person.target,person.sender),'mentions',now)
      return {id,kind:'episode',role,participants:participants.length,sources:sources.length,
        message:'经历已保存；事实、当时的评价和稍后的评价分开存放。概括不会成为新的证据来源。'}
    })
  }
  // Slow generalization: a claim built from several independent experiences,
  // never from one reworded summary. The host derives the confidence class from
  // the roles and counterexamples, so repetition cannot promote it.
  generalize(viewId,args) {
    const view=this.data.view(viewId)
    const claimType=option(args.claimType,CLAIM_KINDS.filter(kind=>kind!=='simulation'),'记忆类型',null)
    const statement=boundedText(args.statement,1200,'主张')
    const context=optionalText(args.context,300,'适用情境')
    const note=optionalText(args.note,500,'解释')
    const episodeIds=args.evidence?.episodes??[]
    const counterIds=args.counter?.episodes??[]
    if(!Array.isArray(episodeIds)||episodeIds.length<2||episodeIds.length>6)throw Error('概括至少需要两条独立经历')
    if(new Set(episodeIds).size!==episodeIds.length)throw Error('同一条经历不能重复计数')
    if(!Array.isArray(counterIds)||counterIds.length>3)throw Error('反例最多三条')
    if(new Set(counterIds).size!==counterIds.length)throw Error('反例不能重复计数')
    const loaded=episodeIds.map(id=>this.load(view,'episode',id))
    const counterLoaded=counterIds.map(id=>this.load(view,'episode',id))
    const dimension=claimType==='impression'?option(args.dimension,IMPRESSION_DIMENSIONS,'印象维度',null):null
    if(claimType==='impression'&&!dimension)throw Error('对人的印象要说明是哪一面：熟悉、信任、喜欢、欣赏还是想模仿')
    const person=PERSON_KINDS.includes(claimType)?(args.person?this.person(view,args.person.messages??[]):null):null
    if(PERSON_REQUIRED.includes(claimType)&&!person)throw Error('关于某个人的概括需要同一真实身份的直接原文')
    // The same messages cannot back two "independent" experiences.
    const used=new Set()
    for(const row of [...loaded,...counterLoaded]){
      const keys=(JSON.parse(row.body).sources??[]).map(source=>source.key)
      if(keys.length&&keys.every(key=>used.has(key)))throw Error('这两段经历引用的是同一批原文，不能算两次独立经历')
      for(const key of keys)used.add(key)
    }
    const support=[],seen=new Set()
    for(const row of loaded)for(const source of JSON.parse(row.body).sources??[]){
      if(seen.has(source.key)||support.length>=10)continue
      seen.add(source.key);support.push({type:source.type,id:source.id,key:source.key,fromEpisode:row.id})
    }
    const counter=[],counterSeen=new Set()
    for(const row of counterLoaded)for(const source of JSON.parse(row.body).sources??[]){
      if(counterSeen.has(source.key)||counter.length>=10)continue
      counterSeen.add(source.key);counter.push({type:source.type,id:source.id,key:source.key,fromEpisode:row.id})
    }
    const roles=loaded.map(row=>JSON.parse(row.body).role)
    const base=roles.includes('worker_report')?'worker_report':roles.includes('told')?'told':'observed'
    const confidence=counter.length?'inference':(loaded.length>=3&&base==='observed'?'observed':base==='observed'?'inference':base)
    const subject=person?person.identity:optionalText(args.subject,200,'主题')||('topic:'+keyOf(statement).slice(0,80))
    if(this.findClaim(view,subject,claimType,statement))return {duplicate:true,message:'这条概括已经存在；新的经历请用修订补充，不要另写一条'}
    const scopes=sourceScopes([...view.scopes,...[...loaded,...counterLoaded].flatMap(row=>JSON.parse(row.scopes))])
    const now=Date.now()
    return this.data.store.transaction(()=>{
      const body={context,support,counter,note,dimension,confidenceRule:confidence,
        derivation:{episodes:episodeIds,counterEpisodes:counterIds},
        displayName:person?String(person.sender):null,simulated:false}
      const id=Number(this.db.prepare('INSERT INTO yoyo_memory_claims(subject,kind,statement,body,scopes,status,confidence,version,episode_id,created_at,updated_at) VALUES(?,?,?,?,?,\'active\',?,1,?,?,?)')
        .run(subject,claimType,statement,JSON.stringify(body),JSON.stringify(scopes),confidence,episodeIds[0],now,now).lastInsertRowid)
      for(const episode of episodeIds)this.link('claim',id,'episode',episode,'generalizes',now)
      this.db.prepare('INSERT INTO yoyo_memory_revisions(claim_id,before,after,basis,confidence,created_at) VALUES(?,NULL,?,?,?,?)')
        .run(id,JSON.stringify({statement,confidence,support}),'generalize:'+episodeIds.join(','),confidence,now)
      return {id,kind:'claim',claimType,confidence,dimension,support:support.length,counter:counter.length,
        message:counter.length?'已记录这条概括，同时保留反例；含反例的概括不会升级为观察。':confidence==='observed'?'三条以上相符经历才形成观察；以后有反例会退回可修正的推断。':'这是一条可修正的概括，还不足以算观察。'}
    })
  }
  proposeClaim(view,args) {
    const claimType=option(args.claimType,CLAIM_KINDS,'记忆类型')
    const sources=this.evidence(view,args.evidence??{})
    const counter=this.evidence(view,args.counter??{})
    let statement=boundedText(args.statement,1200,'主张')
    let confidence=option(args.confidence,CONFIDENCE,'置信类型','inference')
    const context=optionalText(args.context,300,'适用情境')
    const revising=args.claim!==undefined
    const previous=revising?this.load(view,'claim',args.claim):null
    const person=PERSON_KINDS.includes(claimType)&&args.person?this.person(view,args.person.messages??[]):null
    if(person&&person.messages>1&&confidence==='told'&&claimType==='communication')confidence='observed'
    if(claimType==='simulation'&&confidence==='observed')throw Error('模拟的对话或未来不能记成已经发生的事实')
    if(confidence==='observed'&&!sources.length)throw Error('观察到的记忆需要当前可见的原文、回执或网页来源')
    if(claimType==='procedure'&&confidence==='observed'&&!sources.some(ref=>ref.type==='receipt'))throw Error('已验证的方法需要实际工具回执；未实测的方法请标 inference')
    if(claimType==='communication'&&confidence==='observed'&&person&&person.messages<2)throw Error('稳定表达观察需要同一身份至少两条独立原文')
    if(PERSON_REQUIRED.includes(claimType)&&!person&&!revising)throw Error('关于某个人的记忆需要同一真实身份的直接原文')
    const dimension=claimType==='impression'?option(args.dimension,IMPRESSION_DIMENSIONS,'印象维度',null):null
    if(claimType==='impression'&&!dimension)throw Error('对人的印象要说明是哪一面：熟悉、信任、喜欢、欣赏还是想模仿')
    if(args.episode!==undefined&&!this.load(view,'episode',args.episode))throw Error('关联的经历不存在或不在当前资料范围')
    const subject=person?person.identity:optionalText(args.subject,200,'主题')||(previous?previous.subject:null)||('topic:'+keyOf(statement).slice(0,80))
    const scopes=sourceScopes([...view.scopes,...sources.flatMap(ref=>Array.isArray(ref.scope)?ref.scope:[ref.scope]),...counter.flatMap(ref=>Array.isArray(ref.scope)?ref.scope:[ref.scope])])
    const support=sources.map(ref=>({type:ref.type,id:ref.id,key:ref.key,name:ref.name??ref.url??null}))
    const refs=counter.map(ref=>({type:ref.type,id:ref.id,key:ref.key}))
    const now=Date.now()
    if(args.claim!==undefined)return this.revise(view,{id:args.claim,statement,claimType,confidence,confidenceExplicit:args.confidence!==undefined,context,sources,support,refs,now})
    const duplicate=this.findClaim(view,subject,claimType,statement)
    if(duplicate)return this.revise(view,{id:duplicate.id,statement,claimType,confidence,confidenceExplicit:args.confidence!==undefined,context,sources,support,refs,now,implicit:true})
    return this.data.store.transaction(()=>{
      const body={context,support,counter:refs,note:optionalText(args.note,500,'补充'),dimension,displayName:person?String(person.sender):null,simulated:claimType==='simulation'}
      const id=Number(this.db.prepare('INSERT INTO yoyo_memory_claims(subject,kind,statement,body,scopes,status,confidence,version,episode_id,created_at,updated_at) VALUES(?,?,?,?,?,\'active\',?,1,?,?,?)')
        .run(subject,claimType,statement,JSON.stringify(body),JSON.stringify(scopes),confidence,args.episode??null,now,now).lastInsertRowid)
      if(args.episode!==undefined)this.link('claim',id,'episode',args.episode,'derived_from',now)
      this.db.prepare('INSERT INTO yoyo_memory_revisions(claim_id,before,after,basis,confidence,created_at) VALUES(?,NULL,?,?,?,?)')
        .run(id,JSON.stringify({statement,confidence,support}),'create',confidence,now)
      return {id,kind:'claim',claimType,confidence,sources:support.length,
        message:claimType==='simulation'?'模拟只作为设想保存，不会被当作过去的事实或相处证据。':'主张已保存，附来源与置信类型；重复引用同一来源不会提高可信度。'}
    })
  }
  revise(view,{id,statement,claimType,confidence,confidenceExplicit,context,sources,support,refs,now,implicit}) {
    const row=this.db.prepare('SELECT * FROM yoyo_memory_claims WHERE id=?').get(id)
    if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('记忆不在当前资料范围')
    if(row.status==='retracted')throw Error('这条记忆已撤回，不能通过修订复活')
    const finalConfidence=confidenceExplicit?confidence:row.confidence
    const before=JSON.parse(row.body),previous=new Set((before.support??[]).map(ref=>ref.key).filter(Boolean))
    const fresh=support.filter(ref=>!previous.has(ref.key))
    if(!fresh.length&&!implicit)throw Error('重复的来源不能加强这条记忆；需要新的原文或明确的纠正')
    if(!fresh.length&&implicit)return {duplicate:true,id,message:'同一来源已经支持这条记忆，不再重复计数'}
    // Repetition never promotes an inference to an observation: only a new
    // direct source (a real message or a tool receipt) can do that.
    if(finalConfidence==='observed'&&row.confidence!=='observed'&&!fresh.some(ref=>ref.type!=='document'))
      throw Error('重复回忆不能把推断升级为观察，需要新的直接依据')
    const status=row.status==='faded'?'active':row.status
    const after={...before,context:context??before.context,support:[...before.support,...fresh],counter:[...before.counter,...refs.filter(ref=>!(before.counter??[]).some(old=>old.key===ref.key))]}
    this.db.prepare('UPDATE yoyo_memory_claims SET statement=?,kind=?,body=?,status=?,confidence=?,version=version+1,updated_at=? WHERE id=?')
      .run(statement,claimType,JSON.stringify(after),status,finalConfidence,now,id)
    this.db.prepare('INSERT INTO yoyo_memory_revisions(claim_id,before,after,basis,confidence,created_at) VALUES(?,?,?,?,?,?)')
      .run(id,JSON.stringify({statement:row.statement,confidence:row.confidence,support:before.support}),JSON.stringify({statement,confidence:finalConfidence,support:after.support}),fresh.map(ref=>ref.key).join(','),finalConfidence,now)
    return {id,kind:'claim',revised:true,claimType,confidence:finalConfidence,version:row.version+1,added:fresh.map(ref=>ref.key),
      message:'主张已修订并保留旧版本；原话与现在的理解分开存放。'}
  }
  findClaim(view,subject,claimType,statement) {
    const rows=this.db.prepare(`SELECT * FROM yoyo_memory_claims c WHERE c.status='active' AND c.subject=? AND c.kind=? AND ${this.visible('c')} ORDER BY c.id DESC LIMIT 20`)
      .all(subject,claimType,JSON.stringify(view.scopes))
    return rows.find(row=>keyOf(row.statement)===keyOf(statement))??null
  }

  // ---- remembering -------------------------------------------------------
  recall(viewId,args={}) {
    const view=this.data.view(viewId)
    const query=typeof args.query==='string'?args.query.slice(0,300):''
    if(args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>20))throw Error('召回条数无效')
    const limit=args.limit??this.recallLimit
    const wanted=terms(query)
    const personFilter=args.person?String(args.person):null
    const uses=new Map(this.db.prepare('SELECT kind,ref_id,count(*) n FROM yoyo_memory_uses GROUP BY kind,ref_id').all().map(row=>[row.kind+':'+row.ref_id,row.n]))
    const seen=new Set()
    const episodes=this.db.prepare(`SELECT e.* FROM yoyo_memory_episodes e WHERE e.status IN ('active','faded') AND ${this.visible('e')} ORDER BY e.updated_at DESC LIMIT 60`)
      .all(JSON.stringify(view.scopes)).filter(row=>!args.episode||row.id===args.episode)
      .map(row=>({row,body:JSON.parse(row.body)}))
      .filter(({body})=>!personFilter||(body.participants??[]).some(person=>String(person.sender)===personFilter))
      .map(({row,body})=>{
        const text=[row.title,body.scene,body.what,body.turningPoint,body.outcome,body.unresolved].filter(Boolean).join(' ')
        const score=this.score(text,wanted,row,uses.get('episode:'+row.id)??0)
        return {kind:'episode',id:row.id,title:row.title,status:row.status,scene:body.scene,what:body.what,outcome:body.outcome,
          unresolved:body.unresolved||null,role:body.role,occurredFrom:row.occurred_from,occurredTo:row.occurred_to,
          sources:(body.sources??[]).length,score:score.value,matched:score.matched}
      })
    const claims=this.db.prepare(`SELECT c.* FROM yoyo_memory_claims c WHERE c.status IN ('active','faded') AND ${this.visible('c')} ORDER BY c.updated_at DESC LIMIT 80`)
      .all(JSON.stringify(view.scopes))
      .filter(row=>args.includeSimulation===true||row.kind!=='simulation')
      .filter(row=>{
        // One topic should not fill the result twice with the same statement.
        const key=row.subject+'|'+row.kind+'|'+keyOf(row.statement)
        if(seen.has(key))return false
        seen.add(key);return true
      })
      .filter(row=>!personFilter||row.subject===personFilter||row.subject.endsWith(':'+personFilter))
      .filter(row=>!args.episode||row.episode_id===args.episode)
      .map(row=>{
        const body=JSON.parse(row.body)
        const score=this.score(row.statement+' '+(body.context??''),wanted,row,uses.get('claim:'+row.id)??0)
        return {kind:'claim',id:row.id,statement:row.statement,claimType:row.kind,confidence:row.confidence,status:row.status,
          subject:row.subject,context:body.context??'',dimension:body.dimension??null,support:body.support?.length??0,score:score.value,matched:score.matched}
      })
    const ranked=[...episodes,...claims].filter(item=>!wanted.length||item.matched).sort((a,b)=>b.score-a.score).slice(0,limit)
    const used=(args.used??[]).slice(0,10)
    for(const item of used){
      if(!['episode','claim'].includes(item?.kind)||!Number.isSafeInteger(item?.id))continue
      try{this.load(view,item.kind,item.id)}catch{continue}
      this.db.prepare('INSERT INTO yoyo_memory_uses(kind,ref_id,clue,created_at) VALUES(?,?,?,?)').run(item.kind,item.id,query.slice(0,120),Date.now())
    }
    return {mode:'summary',query,person:personFilter,results:ranked,
      guidance:ranked.length?'这些是概要与引用。需要准确原话、日期或金额时用 memory_inspect 核对原文；原话与当时的评价分开考虑。':'当前范围没有相关记忆。没有记忆不等于没有发生过，也不因此推断对方的态度。'}
  }
  // Relevant, unfinished and recently useful memories come first; faded ones
  // need a stronger clue. Reading alone never strengthens a memory.
  score(text,wanted,row,uses) {
    const lower=String(text).toLowerCase()
    let hits=0
    for(const term of wanted)if(lower.includes(term))hits++
    const matched=wanted.length?hits>0:true
    const value=2*Math.min(hits,4)+(uses?0.3*Math.min(uses,3):0)
      +(String(row.body??'').includes('"unresolved":"')&&!/"unresolved":""/.test(String(row.body??''))?0.5:0)
      -(row.status==='faded'?1:0)
      -(Date.now()-(row.updated_at??0)>30*86400000?0.3:0)
    return {value:Math.round(value*100)/100,matched}
  }

  // ---- candidate segmentation --------------------------------------------
  // A segment is a proposal, not a memory. The host only groups consecutive
  // messages by observable boundaries; the subject still decides what an
  // experience meant and what is worth remembering.
  segments(viewId,{after,before=Number.MAX_SAFE_INTEGER,limit=8,gapMs}={}) {
    const view=this.data.view(viewId)
    if(!view.focus)throw Error('分段需要绑定一个聊天窗口')
    if(!Number.isInteger(limit)||limit<1||limit>12)throw Error('分段数量无效')
    const gap=Number.isFinite(gapMs)?Math.max(60000,Math.min(gapMs,86400000)):600000
    const start=Number.isSafeInteger(after)&&after>=0?after:0
    const rows=this.db.prepare("SELECT id,sender,kind,text,segments,received_at FROM yoyo_events WHERE target=? AND id>? AND id<=? ORDER BY id LIMIT 400")
      .all(view.focus,start,before)
    const groups=[]
    let current=null,lastAt=0,previous=new Set()
    for(const row of rows){
      const terms=this.termsOf(row.text)
      const attachment=JSON.parse(row.segments).some(segment=>['forward','file','image'].includes(segment.type))
      let boundary=null
      if(!current)boundary='window_start'
      else if(row.received_at-lastAt>gap)boundary='gap'
      else if(attachment)boundary='attachment'
      else if(current.count>=40)boundary='length'
      else if(current.count>=1&&previous.size>=4&&terms.size>=4&&this.overlap(previous,terms)<0.02)boundary='topic_shift'
      if(!current||boundary){
        current={from:row.id,to:row.id,count:0,boundary,startedAt:row.received_at,senders:new Set(),preview:row.text.slice(0,80)}
        groups.push(current)
      }
      current.to=row.id;current.count++;current.endedAt=row.received_at
      if(row.kind!=='outgoing')current.senders.add(String(row.sender))
      previous=terms;lastAt=row.received_at
    }
    const segments=groups.slice(-limit).map(group=>({...group,senders:[...group.senders]}))
    return {window:view.focus,scopes:view.scopes,segments,
      guidance:segments.length?'这些只是候选分段：真实的开始、转折和结束还要你自己判断。值得记住的用 memory_propose 写成经历，并把你当时的期待与评价写进去；不值得记的可以直接放过。':'这个范围没有可分段的新消息。没有新经历时不必整理。'}
  }
  termsOf(text) {
    const found=new Set()
    for(const word of String(text??'').toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(word=>word.length>1)){
      if(/[\u4e00-\u9fff]/.test(word)){for(let index=0;index+2<=word.length&&found.size<200;index++)found.add(word.slice(index,index+2))}
      else found.add(word)
    }
    return found
  }
  overlap(left,right) {
    if(!left.size||!right.size)return 0
    let shared=0
    for(const term of right)if(left.has(term))shared++
    return shared/(left.size+right.size-shared)
  }

  // ---- inspecting --------------------------------------------------------
  inspect(viewId,args) {
    const view=this.data.view(viewId)
    const kind=option(args.kind,['episode','claim'],'对象类型',null)
    const row=this.load(view,kind,args.id)
    const body=JSON.parse(row.body)
    const available=[]
    for(const source of body.sources??body.support??[]){
      const entry={key:source.key,type:source.type,id:source.id,available:true,reason:null}
      try{
        if(source.type==='event'){const event=this.db.prepare('SELECT scope FROM yoyo_events WHERE id=?').get(source.id);if(!event||!mayRead(view,event.scope))throw Error('x')}
        if(source.type==='receipt'){const receipt=this.db.prepare('SELECT scopes FROM yoyo_tool_sources WHERE run_key=?').get(source.id);if(!receipt||!JSON.parse(receipt.scopes).every(scope=>mayRead(view,scope)))throw Error('x')}
        if(source.type==='document'){const document=this.db.prepare('SELECT scope FROM yoyo_documents WHERE id=?').get(source.id);if(!document||!mayRead(view,document.scope))throw Error('x')}
      }catch{entry.available=false;entry.reason='来源已撤回授权、过期或被删除'}
      available.push(entry)
    }
    const result={kind,id:row.id,status:row.status,version:row.version,scopes:JSON.parse(row.scopes),body:{...body,sources:undefined},sources:available,
      simulated:body.simulated===true,revisions:kind==='claim'?this.db.prepare('SELECT id,before,after,basis,created_at FROM yoyo_memory_revisions WHERE claim_id=? ORDER BY id').all(row.id).length:0}
    if(args.source){
      const source=args.source,offset=args.source.offset??0,characters=args.source.characters??8000
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(characters)||characters<1||characters>24000)throw Error('原文分页范围无效')
      const type=option(source.type,['message','receipt','document'],'来源类型',null)
      result.source=this.sourcePage(view,type,source.id,offset,characters)
    }
    return result
  }
  sourcePage(view,type,id,offset,characters) {
    if(type==='message'){
      const row=this.db.prepare('SELECT id,scope,sender,target,received_at,length(text) total,substr(text,?,?) text FROM yoyo_events WHERE id=?').get(offset+1,characters,id)
      if(!row||!mayRead(view,row.scope))throw Error('原文不在当前资料范围')
      return {type,id:row.id,target:row.target,sender:row.sender,receivedAt:row.received_at,text:row.text,total:row.total,
        next:offset+row.text.length<row.total?offset+row.text.length:null,verbatim:true}
    }
    if(type==='receipt'){
      const row=this.db.prepare('SELECT run_key,name,scopes,result_text FROM yoyo_tool_sources WHERE run_key=?').get(id)
      if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('回执不在当前资料范围')
      return {type,id,name:row.name,text:row.result_text.slice(offset,offset+characters),total:row.result_text.length,
        next:offset+characters<row.result_text.length?offset+characters:null,verbatim:true}
    }
    const row=this.db.prepare('SELECT id,url,body,scope FROM yoyo_documents WHERE id=?').get(id)
    if(!row||!mayRead(view,row.scope))throw Error('网页来源不在当前资料范围')
    return {type,id,url:row.url,text:row.body.slice(offset,offset+characters),total:row.body.length,
      next:offset+characters<row.body.length?offset+characters:null,verbatim:true}
  }

  // ---- fading, archiving, retracting -------------------------------------
  retract(viewId,args) {
    const view=this.data.view(viewId)
    const kind=option(args.kind,['episode','claim'],'对象类型',null)
    const mode=option(args.mode,['fade','archive','retract','forget'],'处理方式',null)
    const row=this.load(view,kind,args.id)
    const reason=boundedText(args.reason,300,'理由')
    const now=Date.now(),scopes=row.scopes,table=kind==='episode'?'yoyo_memory_episodes':'yoyo_memory_claims'
    if(mode==='fade'||mode==='archive'){
      const status=mode==='fade'?'faded':'archived'
      this.db.prepare(`UPDATE ${table} SET status=?,version=version+1,updated_at=? WHERE id=?`).run(status,now,row.id)
      return {id:row.id,kind,status,message:mode==='fade'?'已淡出：需要更明确的线索才会想起，原文保留。':'已归档：退出日常召回，概要与来源仍可核对。'}
    }
    return this.data.store.transaction(()=>{
      const affected=[{kind,id:row.id}]
      this.db.prepare(`UPDATE ${table} SET status='retracted',version=version+1,updated_at=? WHERE id=?`).run(now,row.id)
      this.db.prepare('INSERT OR IGNORE INTO yoyo_memory_retractions(kind,ref,reason,scopes,created_at) VALUES(?,?,?,?,?)').run(kind,String(row.id),reason,scopes,now)
      for(const target of this.dependents(kind,row.id)){
        this.db.prepare("UPDATE yoyo_memory_claims SET status='retracted',version=version+1,updated_at=? WHERE id=? AND status<>'retracted'").run(now,target.id)
        this.db.prepare('INSERT OR IGNORE INTO yoyo_memory_retractions(kind,ref,reason,scopes,created_at) VALUES(?,?,?,?,?)').run('claim',String(target.id),'来源已撤回：'+reason,scopes,now)
        affected.push({kind:'claim',id:target.id})
      }
      const body=JSON.parse(row.body)
      if(mode==='forget')for(const source of body.sources??body.support??[])
        this.db.prepare("INSERT OR IGNORE INTO yoyo_memory_retractions(kind,ref,reason,scopes,created_at) VALUES('source',?,?,?,?)").run(source.key,'用户要求忘记：'+reason,scopes,now)
      return {id:row.id,kind,status:'retracted',affected:affected.length,mode,
        message:mode==='forget'?'已撤回使用，并阻止用同一原文重新形成记忆；原始聊天记录仍按保留规则管理，删除原文需要单独的删除流程。':'已撤回使用，并沿派生关系撤回引用它的主张。'}
    })
  }
  dependents(kind,id) {
    const seen=new Set(),queue=[{kind,id}],out=[]
    while(queue.length){
      const current=queue.shift()
      const links=this.db.prepare("SELECT to_kind,to_id FROM yoyo_memory_links WHERE from_kind=? AND from_id=? AND relation IN ('derived_from','supports','part_of','generalizes')").all(current.kind,current.id)
      for(const link of links){
        const key=link.to_kind+':'+link.to_id
        if(link.to_kind!=='claim'||seen.has(key))continue
        seen.add(key);out.push({id:link.to_id});queue.push({kind:'claim',id:link.to_id})
      }
      if(current.kind==='episode'){
        for(const claim of this.db.prepare('SELECT id FROM yoyo_memory_claims WHERE episode_id=?').all(current.id)){
          const key='claim:'+claim.id
          if(seen.has(key))continue
          seen.add(key);out.push({id:claim.id});queue.push({kind:'claim',id:claim.id})
        }
      }
    }
    return out
  }

  // ---- helpers -----------------------------------------------------------
  link(fromKind,fromId,toKind,toId,relation,now) {
    this.db.prepare('INSERT OR IGNORE INTO yoyo_memory_links(from_kind,from_id,to_kind,to_id,relation,created_at) VALUES(?,?,?,?,?,?)')
      .run(fromKind,fromId,toKind,toId,relation,now)
  }
  load(view,kind,id) {
    if(!Number.isSafeInteger(id)||id<1)throw Error('记忆编号无效')
    const table=kind==='episode'?'yoyo_memory_episodes':'yoyo_memory_claims'
    const row=this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
    if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('记忆不存在或不在当前资料范围')
    if(row.status==='retracted')throw Error('这条记忆已撤回，不再参与召回')
    return row
  }

  // ---- prospective memory ------------------------------------------------
  // A commitment is a host-scheduled reminder, not something the model has to
  // poll for. Each trigger fires once, and closing it needs real behaviour or an
  // explicit confirmation, never a summary that claims it was handled.
  intent(viewId,args={}) {
    const view=this.data.view(viewId)
    if(args.id!==undefined)return this.closeIntent(view,args)
    if(args.statement===undefined)return {intents:this.intents(view)}
    const kind=option(args.kind,INTENT_KINDS,'前瞻类型',null)
    const trigger=option(args.trigger,INTENT_TRIGGERS,'触发方式',null)
    const statement=boundedText(args.statement,500,'打算')
    const doneWhen=optionalText(args.doneWhen,300,'完成条件')
    const cancelWhen=optionalText(args.cancelWhen,300,'取消条件')
    const about=optionalText(args.about,200,'相关对象')
    const note=optionalText(args.note,300,'补充')
    const sources=this.evidence(view,args.evidence??{})
    if(!sources.length)throw Error('前瞻记忆需要依据：哪句原文让你记下这件事')
    if(kind==='commitment'&&!doneWhen&&args.dueAt===undefined)throw Error('承诺需要完成条件或触发时间')
    if(trigger==='time'&&args.dueAt===undefined)throw Error('按时间触发需要 dueAt')
    if(trigger==='window'&&!about)throw Error('按窗口触发需要 about（窗口编号）')
    if(trigger==='window')this.data.target(about,{approved:true})
    if(args.dueAt!==undefined&&(!Number.isSafeInteger(args.dueAt)||args.dueAt<=0||args.dueAt>Date.now()+90*86400000))throw Error('触发时间无效')
    const scopes=sourceScopes([...view.scopes,...sources.flatMap(source=>Array.isArray(source.scope)?source.scope:[source.scope])])
    const body={statement,kind,trigger,doneWhen,cancelWhen,about,note,viewId,dueAt:args.dueAt??null,
      sources:sources.map(source=>({type:source.type,id:source.id,key:source.key}))}
    const now=Date.now()
    const reference=trigger==='window'?this.latestEvent(about):null
    const id=Number(this.db.prepare('INSERT INTO yoyo_memory_intents(kind,body,scopes,state,due_at,consumed_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(kind,JSON.stringify(body),JSON.stringify(scopes),'open',args.dueAt??null,reference,now,now).lastInsertRowid)
    return {id,state:'open',kind,trigger,dueAt:args.dueAt??null,about:about||null,
      message:'记下了。到点或出现真实新消息时宿主会在你的原生边界提醒一次，不会每分钟追问；完成要实际做过或有回执，或者由你明确确认。'}
  }
  latestEvent(handle) {return this.db.prepare('SELECT coalesce(max(id),0) id FROM yoyo_events WHERE target=?').get(handle).id}
  intents(view) {
    const wakes=new Map(this.db.prepare(`SELECT intent_id,outcome,count(*) n FROM yoyo_memory_wakes
      GROUP BY intent_id,outcome`).all().map(row=>[row.intent_id+':'+(row.outcome??'open'),row.n]))
    const count=(id,outcome)=>wakes.get(id+':'+outcome)??0
    return this.db.prepare(`SELECT i.* FROM yoyo_memory_intents i WHERE ${this.visible('i')} ORDER BY (i.state='open') DESC,coalesce(i.due_at,0),i.id DESC LIMIT 30`)
      .all(JSON.stringify(view.scopes)).map(row=>{
        const body=JSON.parse(row.body)
        return {id:row.id,kind:row.kind,state:row.state,statement:body.statement,trigger:body.trigger,
          dueAt:row.due_at??null,about:body.about||null,doneWhen:body.doneWhen||'',cancelWhen:body.cancelWhen||'',
          consumedAt:row.consumed_at??null,completion:body.completion??null,updatedAt:row.updated_at,
          wakes:{delivered:count(row.id,'done')+count(row.id,'dropped')+count(row.id,'ignored')+count(row.id,'open'),
            done:count(row.id,'done'),dropped:count(row.id,'dropped'),ignored:count(row.id,'ignored')},
          nagMuted:row.state==='open'&&count(row.id,'ignored')>=NAG_LIMIT}
      })
  }
  closeIntent(view,args) {
    const row=this.db.prepare('SELECT * FROM yoyo_memory_intents WHERE id=?').get(args.id)
    if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('前瞻记忆不在当前资料范围')
    if(row.state!=='open')throw Error('这件事已经处理过')
    const state=option(args.state,['done','dropped'],'处理结果',null)
    const reason=optionalText(args.reason,300,'理由')
    const now=Date.now(),body=JSON.parse(row.body)
    if(state==='dropped'){
      if(!reason)throw Error('放弃需要说明理由')
      body.completion={state:'dropped',reason,at:now}
    }else if(args.receipt!==undefined){
      if(typeof args.receipt!=='string'||!args.receipt)throw Error('回执编号无效')
      const source=this.db.prepare('SELECT name,scopes FROM yoyo_tool_sources WHERE run_key=?').get(args.receipt)
      if(!source||!JSON.parse(source.scopes).every(scope=>mayRead(view,scope)))throw Error('回执不在当前资料范围')
      if(SELF_TOOLS.has(source.name))throw Error('自述类工具不能证明这件事已经办完')
      body.completion={state:'done',evidence:'tool_receipt',receipt:args.receipt,note:reason,at:now}
    }else if(args.confirmed===true){
      body.completion={state:'done',evidence:'self_report',note:reason,at:now}
    }else throw Error('完成需要实际回执，或由你明确 confirmed 确认')
    this.db.prepare('UPDATE yoyo_memory_intents SET state=?,body=?,updated_at=? WHERE id=?').run(state,JSON.stringify(body),now,row.id)
    // Closing an intention is the only real evidence that the reminder worked.
    this.db.prepare('UPDATE yoyo_memory_wakes SET outcome=?,resolved_at=? WHERE intent_id=? AND outcome IS NULL')
      .run(state==='done'?'done':'dropped',now,row.id)
    return {id:row.id,state,completion:body.completion,
      message:state==='done'?'已结束这件事。若只是聊过、没真的做，请如实说明。':'已放弃这件事，理由保留在记录里。'}
  }
  dueIntent(now=Date.now()) {
    for(const row of this.db.prepare("SELECT * FROM yoyo_memory_intents WHERE state='open' ORDER BY coalesce(due_at,0),id LIMIT 20").all()){
      const body=JSON.parse(row.body)
      let view
      try{view=this.data.view(body.viewId)}catch{continue}
      if(!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))continue
      if(body.trigger==='time'){
        if(Number.isSafeInteger(body.dueAt)&&body.dueAt<=now&&(row.consumed_ref??0)<body.dueAt)
          return {id:row.id,statement:body.statement,kind:body.kind,about:body.about||null,doneWhen:body.doneWhen,cancelWhen:body.cancelWhen,view,reason:'time',consumedRef:body.dueAt}
      }else if(body.trigger==='window'&&body.about){
        const latest=this.latestEvent(body.about)
        if(latest>(row.consumed_ref??0)&&this.ignoredWakes(row.id)<NAG_LIMIT)
          return {id:row.id,statement:body.statement,kind:body.kind,about:body.about,doneWhen:body.doneWhen,cancelWhen:body.cancelWhen,view,reason:'event',through:latest,consumedRef:latest}
      }
    }
    return null
  }
  consumeIntent(id,reference) {
    const row=this.db.prepare('SELECT body FROM yoyo_memory_intents WHERE id=?').get(id)
    const body=row?JSON.parse(row.body):{}
    const now=Date.now()
    // Being woken again before closing the previous wake means the earlier
    // reminder achieved nothing; it is counted as ignored, never as effective.
    this.db.prepare("UPDATE yoyo_memory_wakes SET outcome='ignored',resolved_at=? WHERE intent_id=? AND outcome IS NULL").run(now,id)
    this.db.prepare('INSERT INTO yoyo_memory_wakes(intent_id,view_id,reason,outcome,created_at) VALUES(?,?,?,NULL,?)')
      .run(id,body.viewId??'',body.trigger??'explicit',now)
    this.db.prepare('UPDATE yoyo_memory_intents SET consumed_at=?,consumed_ref=max(coalesce(consumed_ref,0),?) WHERE id=?')
      .run(now,Number.isSafeInteger(reference)?reference:0,id)
    return {id,consumed:true}
  }
  ignoredWakes(intentId) {
    return this.db.prepare("SELECT count(*) n FROM yoyo_memory_wakes WHERE intent_id=? AND outcome='ignored'").get(intentId).n
  }
  // Only counts are exposed: what was remembered and why stays inside its scope.
  wakeStats(view) {
    const stats={delivered:0,done:0,dropped:0,ignored:0,open:0}
    const rows=this.db.prepare(`SELECT w.outcome,count(*) n FROM yoyo_memory_wakes w
      JOIN yoyo_memory_intents i ON i.id=w.intent_id WHERE ${this.visible('i')} GROUP BY w.outcome`).all(JSON.stringify(view.scopes))
    for(const row of rows){
      stats.delivered+=row.n
      if(row.outcome==='done')stats.done+=row.n
      else if(row.outcome==='dropped')stats.dropped+=row.n
      else if(row.outcome==='ignored')stats.ignored+=row.n
      else stats.open+=row.n
    }
    return stats
  }

  // ---- legacy migration --------------------------------------------------
  // The older yoyo_memories rows keep their text, their scopes and their
  // provenance. They arrive as unverified material: migration never raises a
  // confidence class, and the original rows stay active until reviewed.
  migrateLegacy({limit=200}={}) {
    const rows=this.db.prepare(`SELECT m.* FROM yoyo_memories m WHERE m.active=1
      AND NOT EXISTS(SELECT 1 FROM yoyo_memory_migrations g WHERE g.legacy_id=m.id) ORDER BY m.id LIMIT ?`).all(limit)
    const type={episodes:'fact',profile:'fact',relations:'fact',knowledge:'knowledge',procedures:'procedure',intention:'self',communication:'communication'}
    const migrated=[]
    for(const row of rows){
      const scopes=JSON.stringify(sourceScopes(JSON.parse(row.scopes)))
      if(this.db.prepare('SELECT 1 FROM yoyo_memory_claims WHERE statement=? AND scopes=?').get(row.body,scopes))continue
      const claimType=type[row.kind]??'fact'
      const body={context:'',support:[],counter:[],note:'旧记忆迁移：来源与类型沿用原记录，尚未按新结构核实',dimension:null,
        legacy:{memoryId:row.id,kind:row.kind,confidence:row.confidence},needsReview:true,simulated:false}
      const now=Date.now()
      const id=Number(this.db.prepare('INSERT INTO yoyo_memory_claims(subject,kind,statement,body,scopes,status,confidence,version,episode_id,created_at,updated_at) VALUES(?,?,?,?,?,\'active\',\'inference\',1,NULL,?,?)')
        .run('legacy:'+row.kind,claimType,row.body,JSON.stringify(body),scopes,now,now).lastInsertRowid)
      this.db.prepare('INSERT INTO yoyo_memory_revisions(claim_id,before,after,basis,confidence,created_at) VALUES(?,NULL,?,?,?,?)')
        .run(id,JSON.stringify({statement:row.body,confidence:'inference',support:[]}),'migrate:legacy','inference',now)
      this.db.prepare('INSERT INTO yoyo_memory_migrations(legacy_id,claim_id,created_at) VALUES(?,?,?)').run(row.id,id,now)
      migrated.push({legacy:row.id,claim:id})
    }
    return {migrated:migrated.length,claims:migrated,
      message:migrated.length?'旧记忆已按新结构登记为待核实材料；原文、范围与旧记录都保留，不会因此提高可信度。':'没有需要迁移的旧记忆。'}
  }
  summary(view) {
    if(!view)return null
    const scopes=JSON.stringify(view.scopes)
    const count=(table,extra='')=>this.db.prepare(`SELECT count(*) n FROM ${table} t WHERE ${this.visible('t')} ${extra}`).get(scopes).n
    const unresolved=this.db.prepare(`SELECT count(*) n FROM yoyo_memory_episodes e WHERE ${this.visible('e')} AND e.status='active' AND json_extract(e.body,'$.unresolved') NOT IN ('',NULL)`)
      .get(scopes).n
    return {episodes:count('yoyo_memory_episodes',"AND t.status IN ('active','faded')"),
      claims:count('yoyo_memory_claims',"AND t.status IN ('active','faded')"),
      archived:count('yoyo_memory_episodes',"AND t.status='archived'")+count('yoyo_memory_claims',"AND t.status='archived'"),
      intents:count('yoyo_memory_intents',"AND t.state='open'"),
      wakes:this.wakeStats(view),
      unresolved}
  }

  register(define) {
    define('memory_recall','按线索想起当前范围内的经历与主张，只返回概要与引用；需要原话时用 memory_inspect。线索可以是参与者、话题或未完成事项。没有相关记忆不等于没有发生。',
      {query:{type:'string',maxLength:300},person:{type:'string',maxLength:200},episode:{type:'integer',minimum:1},
        limit:{type:'integer',minimum:1,maximum:20},includeSimulation:{type:'boolean'},
        used:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['episode','claim']},id:{type:'integer',minimum:1}},required:['kind','id']}}},
      [],async(args,exec,key,view)=>this.recall(view.id,args))
    define('memory_inspect','核对一条记忆的原始依据：返回记录、来源是否仍可用，并可按 offset 分页读原始消息、工具回执或网页正文。摘要不是原文。',
      {kind:{type:'string',enum:['episode','claim']},id:{type:'integer',minimum:1},
        source:{type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['message','receipt','document']},
          id:{type:['integer','string']},offset:{type:'integer',minimum:0},characters:{type:'integer',minimum:1,maximum:24000}}}},
      ['kind','id'],async(args,exec,key,view)=>this.inspect(view.id,args))
    define('memory_propose','提交带来源的经历或主张，或修订已有主张。经历记录场景、真实参与者、角色、结果与未解决事项；主张记录类型、适用情境、置信类型、支持与反例。转发和引文不能当本人身份；同一来源不重复计数。',
      {kind:{type:'string',enum:['episode','claim']},
        title:{type:'string',maxLength:200},role:{type:'string',enum:ROLES},scene:{type:'string',maxLength:500},
        what:{type:'string',maxLength:2000},turningPoint:{type:'string',maxLength:1000},outcome:{type:'string',maxLength:1000},
        unresolved:{type:'string',maxLength:1000},expectation:{type:'string',maxLength:1000},appraisal:{type:'string',maxLength:1000},
        laterAppraisal:{type:'string',maxLength:1000},note:{type:'string',maxLength:500},
        occurredFrom:{type:'integer',minimum:0},occurredTo:{type:'integer',minimum:0},
        claimType:{type:'string',enum:CLAIM_KINDS},statement:{type:'string',maxLength:1200},context:{type:'string',maxLength:300},
        dimension:{type:'string',enum:IMPRESSION_DIMENSIONS},
        subject:{type:'string',maxLength:200},person:{type:'object',additionalProperties:false,properties:{messages:{type:'array',maxItems:10,items:{type:'integer',minimum:1}}}},
        confidence:{type:'string',enum:CONFIDENCE},episode:{type:'integer',minimum:1},claim:{type:'integer',minimum:1},
        evidence:{type:'object',additionalProperties:false,properties:{messages:{type:'array',maxItems:10,items:{type:'integer',minimum:1}},receipts:{type:'array',maxItems:10,items:{type:'string',maxLength:500}},documents:{type:'array',maxItems:10,items:{type:'integer',minimum:1}},range:{type:'object',additionalProperties:false,properties:{from:{type:'integer',minimum:1},to:{type:'integer',minimum:1}}}}},
        counter:{type:'object',additionalProperties:false,properties:{messages:{type:'array',maxItems:10,items:{type:'integer',minimum:1}},receipts:{type:'array',maxItems:10,items:{type:'string',maxLength:500}},documents:{type:'array',maxItems:10,items:{type:'integer',minimum:1}}}}},
      ['kind'],async(args,exec,key,view)=>this.propose(view.id,args))
    define('memory_retract','淡出、归档、撤回或按要求忘记一条记忆。撤回会沿派生关系传递到引用它的主张；忘记还会阻止用同一原文重新形成记忆。原文删除属于单独的删除流程。',
      {kind:{type:'string',enum:['episode','claim']},id:{type:'integer',minimum:1},
        mode:{type:'string',enum:['fade','archive','retract','forget']},reason:{type:'string',maxLength:300}},
      ['kind','id','mode','reason'],async(args,exec,key,view)=>this.retract(view.id,args))
    define('memory_segments','把一个窗口的新消息按时间间隔、附件和话题变化切成候选分段，返回每段起止、参与者、边界原因和开头预览。分段只是候选，不是记忆：值得记住的要你自己写成经历。',
      {after:{type:'integer',minimum:0},before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:12},gapMs:{type:'integer',minimum:60000,maximum:86400000}},
      [],async(args,exec,key,view)=>this.segments(view.id,args))
    define('memory_intent','前瞻记忆：记下承诺、打算或等待中的事。无参数查看当前范围未结束的事（含已提醒次数：完成、放弃与未被理会的次数）。可按时间或按窗口新消息触发，宿主在原生边界提醒一次，不轮询；连续多次没被理会的事项会安静下来（nagMuted），要么办完、要么说明理由放弃。完成要有实际回执或你明确确认；放弃要说明理由。',
      {id:{type:'integer',minimum:1},statement:{type:'string',maxLength:500},kind:{type:'string',enum:INTENT_KINDS},
        trigger:{type:'string',enum:INTENT_TRIGGERS},about:{type:'string',maxLength:200},dueAt:{type:'integer',minimum:1},
        doneWhen:{type:'string',maxLength:300},cancelWhen:{type:'string',maxLength:300},note:{type:'string',maxLength:300},
        evidence:{type:'object',additionalProperties:false,properties:{messages:{type:'array',maxItems:10,items:{type:'integer',minimum:1}}}},
        state:{type:'string',enum:['done','dropped']},receipt:{type:'string',maxLength:500},confirmed:{type:'boolean'},
        reason:{type:'string',maxLength:300}},[],async(args,exec,key,view)=>this.intent(view.id,args))
    define('memory_generalize','从多段经历慢慢概括一条可修正的主张或对人的某一面印象（熟悉／信任／喜欢／欣赏／想模仿分开保存）。至少要两条独立经历；同一批原文不能算两次；有反例就退回推断。无参数请改用 memory_recall 查看已有记忆。',
      {claimType:{type:'string',enum:CLAIM_KINDS.filter(kind=>kind!=='simulation')},statement:{type:'string',minLength:1,maxLength:1200},
        subject:{type:'string',maxLength:200},context:{type:'string',maxLength:300},note:{type:'string',maxLength:500},
        dimension:{type:'string',enum:IMPRESSION_DIMENSIONS},
        person:{type:'object',additionalProperties:false,properties:{messages:{type:'array',maxItems:10,items:{type:'integer',minimum:1}}}},
        evidence:{type:'object',additionalProperties:false,properties:{episodes:{type:'array',minItems:2,maxItems:6,items:{type:'integer',minimum:1}}}},
        counter:{type:'object',additionalProperties:false,properties:{episodes:{type:'array',maxItems:3,items:{type:'integer',minimum:1}}}}},
      ['claimType','statement','evidence'],async(args,exec,key,view)=>this.generalize(view.id,args))
  }
}
function hashIdentity(target,sender) {
  return createHash('sha256').update(JSON.stringify([target,String(sender)])).digest('hex').slice(0,24)
}
