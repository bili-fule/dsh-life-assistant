import { createHash } from 'node:crypto'
import { boundedText,mayRead,sourceScopes } from './scope.mjs'

// The host keeps bounded, scoped records of expectation, experience and
// preference. It never exposes a writable happiness score, never counts the
// same real event twice and never lets one unpleasant turn become a durable
// verdict about a person or a group.
export const MOTIVATION_TOOLS=['self_options','self_choose','self_appraise','self_preferences']
export const MOTIVATION_POLICY=`你可以用 self_options 查看当前情绪基调、模拟负荷、重复饱和、相关偏好和未完成的选择；用 self_choose 记录少量候选、自己的选择、期待和退出条件；用 self_appraise 在事件之后对照期待记录实际感受与事后是否值得；用 self_preferences 查看偏好、处理待定修订或撤销。偏好数值由宿主按可核实的真实事件有界更新：同一事件只计一次，自述或执行者转述不会自动提高满足，单一不愉快经历不会立刻把相关活动或某人永久判为讨厌，需要多次相符经历才稳定。私人范围的选择与感受不会改变公开可观察的情绪；不提供可以直接写入的快乐总分。没有值得做的事可以休息，不必为了保持活跃制造活动或额外执行者。`

const LEVELS=['low','medium','high']
const LEVEL_VALUE={low:0.3,medium:0.6,high:0.9}
const LIKED={liked:1,neutral:0,disliked:-1}
const WEIGHT={low:0.5,medium:1,high:1.5}
const EFFORT={low:0.15,medium:0.25,high:0.35}
const WORTH=['worth','unsure','not_worth']
const PROGRESS=['yes','no','unknown']
// Receipts from the agent's own notebooks and from worker reports prove that
// something was written or said, not that anything actually happened.
const NARRATIVE_NAMES=new Set(['yoyo_memory','yoyo_forget','yoyo_recall','yoyo_evidence','yoyo_self','yoyo_sleep','yoyo_wait','yoyo_learning','yoyo_concern','yoyo_feedback','yoyo_plan','yoyo_activity','life_context',...MOTIVATION_TOOLS])
const REPORT_NAMES=new Set(['team_overview','team_deliberate','team_inspect','team_review'])
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value))
const round=value=>Math.round(value*1000)/1000
const keyOf=text=>text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'').slice(0,120)
const emptyPreference=()=>({wanting:0,liking:0,samples:0,stable:false,note:'',evidence:[],counter:[],window:{since:0,delta:0}})
const STABLE=0.4
function option(value,list,label,fallback=null) {
  if(value===undefined||value===null)return fallback
  if(!list.includes(value))throw Error(label+'无效')
  return value
}
function optionalText(value,max,label) {return value===undefined||value===null||value===''?'':boundedText(value,max,label)}

export class Motivation {
  constructor(data,config={}) {
    this.data=data;this.db=data.db
    this.mode=config.mode==='choose'?'choose':'record'
    // Upper bound on how far one preference may move within an hour. This is an
    // anti-gaming brake, not a psychological constant.
    this.maxPerHour=Number.isFinite(config.maxDeltaPerHour)?clamp(config.maxDeltaPerHour,0.05,1):0.45
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_motivation_affect(scopes TEXT PRIMARY KEY,body TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_motivation_choices(
        id INTEGER PRIMARY KEY,activity TEXT NOT NULL,activity_key TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'activity',
        state TEXT NOT NULL DEFAULT 'open',body TEXT NOT NULL,scopes TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS yoyo_motivation_choices_state ON yoyo_motivation_choices(state,updated_at);
      CREATE TABLE IF NOT EXISTS yoyo_motivation_experiences(
        id INTEGER PRIMARY KEY,choice_id INTEGER NOT NULL,activity_key TEXT NOT NULL,dedup TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,scopes TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_motivation_preferences(
        id INTEGER PRIMARY KEY,activity TEXT NOT NULL,activity_key TEXT NOT NULL,context TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,scopes TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,
        UNIQUE(activity_key,context,scopes));
      CREATE TABLE IF NOT EXISTS yoyo_motivation_revisions(
        id INTEGER PRIMARY KEY,preference_id INTEGER,activity_key TEXT NOT NULL,context TEXT NOT NULL DEFAULT '',
        before TEXT,after TEXT NOT NULL,basis TEXT NOT NULL,confidence TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'proposed',reason TEXT,experience_id INTEGER,
        scopes TEXT NOT NULL,created_at INTEGER NOT NULL,decided_at INTEGER);
    `)
  }
  scopeKey(view) {return JSON.stringify(sourceScopes(view.scopes))}
  visible(alias) {return `NOT EXISTS(SELECT 1 FROM json_each(${alias}.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?)))`}

  // ---- reading -----------------------------------------------------------
  affect(view) {
    const exact=this.db.prepare('SELECT body FROM yoyo_motivation_affect WHERE scopes=?').get(this.scopeKey(view))
    const other=exact?null:this.db.prepare(`SELECT body FROM yoyo_motivation_affect a WHERE ${this.visible('a')} ORDER BY a.updated_at DESC LIMIT 1`).get(JSON.stringify(view.scopes))
    const row=exact??other
    const body=row?JSON.parse(row.body):{valence:0,mood:'calm',load:0,satiation:{},events:0,updatedAt:0}
    return {...body,source:exact?'current':other?'related':'none'}
  }
  discount(count) {return round(1-Math.min(0.65,0.2*(count??0)))}
  levelOf(wanting) {return wanting>=0.55?'high':wanting>=0.15?'medium':'low'}
  choiceView(row) {
    const body=JSON.parse(row.body)
    return {id:row.id,activity:row.activity,kind:row.kind,state:row.state,chosen:body.chosen,context:body.context,
      concern:body.concern??null,expected:body.expected,candidateCount:body.candidates.length,budget:body.budget,reason:body.reason,
      confidence:body.confidence,returnWhen:body.returnWhen??null,createdAt:row.created_at,updatedAt:row.updated_at}
  }
  openChoices(view) {
    return this.db.prepare(`SELECT c.* FROM yoyo_motivation_choices c WHERE c.state='open' AND ${this.visible('c')} ORDER BY c.updated_at DESC LIMIT 10`)
      .all(JSON.stringify(view.scopes)).map(row=>this.choiceView(row))
  }
  openChoice(view,id) {
    const row=this.db.prepare("SELECT * FROM yoyo_motivation_choices WHERE id=? AND state='open'").get(id)
    if(!row||!JSON.parse(row.scopes).every(s=>mayRead(view,s)))return null
    return this.choiceView(row)
  }
  preferenceList(view) {
    return this.db.prepare(`SELECT p.* FROM yoyo_motivation_preferences p WHERE ${this.visible('p')} ORDER BY p.updated_at DESC LIMIT 30`)
      .all(JSON.stringify(view.scopes)).map(row=>({id:row.id,activity:row.activity,activityKey:row.activity_key,context:row.context,
        version:row.version,updatedAt:row.updated_at,scopes:JSON.parse(row.scopes),...JSON.parse(row.body)}))
  }
  revisionView(row) {
    const before=row.before?JSON.parse(row.before):null,after=JSON.parse(row.after)
    return {id:row.id,preferenceId:row.preference_id,activityKey:row.activity_key,context:row.context,
      change:{liking:round(after.liking-(before?.liking??0)),wanting:round(after.wanting-(before?.wanting??0))},
      basis:row.basis,confidence:row.confidence,state:row.state,reason:row.reason,experience:row.experience_id,createdAt:row.created_at}
  }
  proposals(view) {
    return this.db.prepare(`SELECT r.* FROM yoyo_motivation_revisions r WHERE r.state='proposed' AND ${this.visible('r')} ORDER BY r.id DESC LIMIT 20`)
      .all(JSON.stringify(view.scopes)).map(row=>this.revisionView(row))
  }
  recentExperiences(view,limit=8) {
    return this.db.prepare(`SELECT e.* FROM yoyo_motivation_experiences e WHERE ${this.visible('e')} ORDER BY e.id DESC LIMIT ?`)
      .all(JSON.stringify(view.scopes),limit).map(row=>{
        const body=JSON.parse(row.body)
        return {id:row.id,choice:row.choice_id,activity:body.activity,liked:body.liked,worth:body.worth,progress:body.progress,
          credit:body.credit,evidence:body.evidenceType,repeatKey:body.repeatKey,later:body.later,at:row.created_at}
      })
  }
  options(viewId,{activity}={}) {
    const view=this.data.view(viewId)
    const affect=this.affect(view)
    const open=this.openChoices(view)
    const filter=activity?keyOf(boundedText(activity,120,'活动')):null
    const preferences=this.preferenceList(view).filter(p=>!filter||p.activityKey===filter||p.activity.includes(String(activity))).slice(0,10)
    const repeat=Object.entries(affect.satiation??{}).filter(([key])=>!filter||key===filter)
      .map(([key,value])=>({activity:key,repeatKey:value.key,count:value.count,continuedValue:this.discount(value.count)}))
    return {
      mode:this.mode,
      scopes:view.scopes,
      affect:{mood:affect.mood,valence:affect.valence,load:affect.load,events:affect.events,updatedAt:affect.updatedAt,source:affect.source},
      current:open[0]??null,
      open,
      preferences,
      proposals:this.proposals(view),
      recent:this.recentExperiences(view),
      repeat,
      stateNote:this.mode==='record'?'当前是记录阶段：这些记录不自动改变权限、提醒或发信。':null,
      guidance:'候选由你自己形成，可以包含继续当前活动、只看不说、查一个问题、邀请执行者一起做或休息。预计的愉快和事后满足、所需投入、是否重复、关系影响、承诺和不确定性都值得比较，普通小决定不必填满每一项。没有值得做的事时可以休息，不要为保持活跃合成任务。评估只在事件之后、明确的新证据或自己安排的时间，不因时间流逝反复重评。'
    }
  }

  // ---- deciding ----------------------------------------------------------
  choose(viewId,args) {
    const view=this.data.view(viewId)
    const activity=boundedText(args.activity,120,'活动')
    const activityKey=keyOf(activity),context=optionalText(args.context,120,'情境')
    const confidence=option(args.confidence,LEVELS,'自信程度','medium')
    if(args.candidates!==undefined&&!Array.isArray(args.candidates))throw Error('候选格式无效')
    const candidates=(args.candidates??[]).slice(0,6).map(candidate=>{
      if(!candidate||typeof candidate!=='object')throw Error('候选格式无效')
      return {label:boundedText(candidate.label,120,'候选'),
        appeal:option(candidate.appeal,LEVELS,'吸引力','medium'),
        expectedPleasure:option(candidate.expectedPleasure,LEVELS,'预计愉快','medium'),
        expectedSatisfaction:option(candidate.expectedSatisfaction,LEVELS,'预计满足','medium'),
        effort:option(candidate.effort,LEVELS,'投入','medium'),
        uncertainty:option(candidate.uncertainty,LEVELS,'不确定性','medium'),
        repeated:!!candidate.repeated,
        relation:optionalText(candidate.relation,300,'关系影响'),
        commitment:optionalText(candidate.commitment,300,'相关承诺'),
        continueWhen:optionalText(candidate.continueWhen,300,'继续条件'),
        exitWhen:optionalText(candidate.exitWhen,300,'退出条件')}
    })
    const chosen=boundedText(args.chosen,120,'选择')
    if(candidates.length&&!candidates.some(c=>c.label===chosen))throw Error('选择必须是候选之一；把 candidates 留空表示轻量记录')
    const kind=args.rest===true||/^(rest|休息|不做|什么都不做|暂时不做|暂停)$/i.test(chosen)?'rest':'activity'
    if(args.budget!==undefined&&args.budget!==null){
      const {steps,minutes}=args.budget
      if(steps!==undefined&&(!Number.isInteger(steps)||steps<1||steps>200))throw Error('预算步数无效')
      if(minutes!==undefined&&(!Number.isInteger(minutes)||minutes<1||minutes>1440))throw Error('预算时长无效')
    }
    const preference=this.preferenceList(view).find(p=>p.activityKey===activityKey&&p.context===context)
    let concern=null
    if(args.concern!==undefined){
      concern=this.data.concerns(viewId).find(c=>c.id===args.concern)
      if(!concern)throw Error('关联的关切不存在或不在当前资料范围')
    }
    const chosenCandidate=candidates.find(c=>c.label===chosen)
    const expected=chosenCandidate??{label:chosen,appeal:'medium',expectedPleasure:preference?this.levelOf(preference.wanting):'medium',
      expectedSatisfaction:'medium',effort:'medium',uncertainty:'medium',repeated:!!preference?.stable,
      relation:'',commitment:'',continueWhen:'',exitWhen:''}
    const body={chosen,context,candidates,expected,concern:concern?.id??null,reason:boundedText(args.reason??'自己的选择',1000,'理由'),confidence,
      budget:args.budget??null,returnWhen:optionalText(args.returnWhen,300,'返回条件')}
    const scopes=JSON.stringify(sourceScopes(view.scopes)),now=Date.now()
    return this.data.store.transaction(()=>{
      this.db.prepare("UPDATE yoyo_motivation_choices SET state='superseded',updated_at=? WHERE state='open' AND activity_key=? AND scopes=?").run(now,activityKey,scopes)
      const id=Number(this.db.prepare('INSERT INTO yoyo_motivation_choices(activity,activity_key,kind,state,body,scopes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(activity,activityKey,kind,'open',JSON.stringify(body),scopes,now,now).lastInsertRowid)
      return {id,activity,chosen,kind,concern:body.concern,
        expected:{appeal:expected.appeal,pleasure:expected.expectedPleasure,satisfaction:expected.expectedSatisfaction,effort:expected.effort},
        budget:body.budget,returnWhen:body.returnWhen,
        message:kind==='rest'?'休息是完整的候选行为：可以没有产出，返回条件可选。':'期待已保存；事件之后用 self_appraise 对照记录实际感受。'}
    })
  }

  // ---- appraising --------------------------------------------------------
  appraise(viewId,args) {
    const view=this.data.view(viewId)
    if(!Number.isSafeInteger(args.choice))throw Error('评价需要对应选择编号')
    const row=this.db.prepare('SELECT * FROM yoyo_motivation_choices WHERE id=?').get(args.choice)
    if(!row)throw Error('选择记录不存在')
    const choiceScopes=JSON.parse(row.scopes)
    if(!choiceScopes.every(s=>mayRead(view,s)))throw Error('该选择不在当前资料范围')
    const liked=option(args.liked,Object.keys(LIKED),'实际感受')
    if(!liked)throw Error('需要写明喜欢、无感或不喜欢')
    const worth=option(args.worthAfter,WORTH,'事后评价','unsure')
    const progress=option(args.progress,PROGRESS,'进展','unknown')
    const confidence=option(args.confidence,LEVELS,'自信程度','medium')
    const outcome=boundedText(args.outcome,1000,'实际结果')
    const explanation=optionalText(args.explanation,1500,'解释')
    const repeatKey=args.repeatKey?boundedText(args.repeatKey,120,'重复标识'):null
    const choiceBody=JSON.parse(row.body)
    const scopes=sourceScopes([...choiceScopes,...view.scopes])
    const evidence=args.evidence??{}
    const messages=(evidence.messages??[]).slice(0,10),receipts=(evidence.receipts??[]).slice(0,10)
    if(!Array.isArray(messages)||!Array.isArray(receipts)||messages.length>10||receipts.length>10)throw Error('证据格式无效')
    const evidenceType=this.evidenceType(view,messages,receipts)
    if(args.laterOf!==undefined)return this.later(view,args,{row,choiceBody,scopes,liked,worth,progress,confidence,outcome,explanation,evidenceType})
    const signature=JSON.stringify(['event',row.activity_key,choiceBody.context??'',messages.slice().sort(),receipts.slice().sort(),keyOf(outcome),liked,worth,progress,repeatKey??''])
    const dedup=createHash('sha256').update(signature).digest('hex')
    if(this.db.prepare('SELECT id FROM yoyo_motivation_experiences WHERE dedup=?').get(dedup))return {duplicate:true,message:'同一事件只计一次，偏好不再重复更新'}
    return this.data.store.transaction(()=>{
      const now=Date.now()
      const record={activity:row.activity,context:choiceBody.context??'',expected:choiceBody.expected??null,
        outcome,liked,worth,progress,explanation,confidence,evidenceType,credit:['tool_receipt','message'].includes(evidenceType)?'observed':'unverified',repeatKey,later:null}
      const id=Number(this.db.prepare('INSERT INTO yoyo_motivation_experiences(choice_id,activity_key,dedup,body,scopes,created_at) VALUES(?,?,?,?,?,?)')
        .run(row.id,row.activity_key,dedup,JSON.stringify(record),JSON.stringify(scopes),now).lastInsertRowid)
      if(args.end===true)this.db.prepare("UPDATE yoyo_motivation_choices SET state='done',updated_at=? WHERE id=?").run(now,row.id)
      const affect=this.applyExperience({row,choiceBody,scopes,record,confidence,now,experience:id})
      return {experience:id,duplicate:false,evidence:evidenceType,credit:record.credit,
        affect:{mood:affect.state.mood,valence:affect.state.valence,load:affect.state.load,continuedValue:affect.continuedValue},
        preference:affect.preference,revision:affect.revision,
        message:record.credit==='observed'?'期待与实际感受已分别保存；偏好按这条真实经历有界更新。':'这次只有自述或执行者转述，已记录经历，但不提高满足或偏好。'}
    })
  }
  later(view,args,{row,choiceBody,scopes,liked,worth,progress,confidence,outcome,explanation,evidenceType}) {
    const original=this.db.prepare('SELECT * FROM yoyo_motivation_experiences WHERE id=?').get(args.laterOf)
    if(!original||!JSON.parse(original.scopes).every(s=>mayRead(view,s)))throw Error('原经历不在当前资料范围')
    if(original.choice_id!==row.id)throw Error('复查必须对应同一次选择')
    const signature=JSON.stringify(['later',args.laterOf,worth,keyOf(outcome)])
    const dedup=createHash('sha256').update(signature).digest('hex')
    if(this.db.prepare('SELECT id FROM yoyo_motivation_experiences WHERE dedup=?').get(dedup))return {duplicate:true,message:'同一复查只计一次'}
    return this.data.store.transaction(()=>{
      const now=Date.now()
      const body=JSON.parse(original.body),record={...body,outcome,liked,worth,progress,explanation,confidence,evidenceType,credit:body.credit,later:{of:args.laterOf,at:now}}
      const id=Number(this.db.prepare('INSERT INTO yoyo_motivation_experiences(choice_id,activity_key,dedup,body,scopes,created_at) VALUES(?,?,?,?,?,?)')
        .run(row.id,row.activity_key,dedup,JSON.stringify(record),JSON.stringify(scopes),now).lastInsertRowid)
      body.later={worth,explanation,at:now}
      this.db.prepare('UPDATE yoyo_motivation_experiences SET body=? WHERE id=?').run(JSON.stringify(body),args.laterOf)
      // A later "not worth it" can revise a rewarding memory, but only as a
      // proposal the subject has to confirm; the original event is never replayed.
      const counter=body.credit==='observed'&&worth==='not_worth'&&body.liked==='liked'
      const result=counter?this.revisePreference({row,choiceBody,scopes,record:{...record,liked:'disliked',credit:'observed',explanation},confidence,now,experience:id,weight:0.6,alwaysPropose:true}):null
      return {experience:id,later:true,duplicate:false,evidence:evidenceType,credit:record.credit,
        revision:result?result.revision:null,
        message:result?'事后觉得不值得，已提出一条需要自己确认的修正；原经历保留。':'这次复查只更新了原来的事后评价。'}
    })
  }
  evidenceType(view,messages,receipts) {
    for(const id of messages){
      if(!Number.isSafeInteger(id)||id<1)throw Error('消息证据编号无效')
      const event=this.db.prepare('SELECT scope FROM yoyo_events WHERE id=?').get(id)
      if(!event||!mayRead(view,event.scope))throw Error('消息证据不在当前资料范围')
    }
    let tool=false,narrative=false,report=false
    for(const key of receipts){
      if(typeof key!=='string'||!key)throw Error('工具回执编号无效')
      const source=this.db.prepare('SELECT name,scopes FROM yoyo_tool_sources WHERE run_key=?').get(key)
      if(!source||!JSON.parse(source.scopes).every(s=>mayRead(view,s)))throw Error('工具回执不在当前资料范围')
      if(NARRATIVE_NAMES.has(source.name))narrative=true
      else if(REPORT_NAMES.has(source.name))report=true
      else tool=true
    }
    if(tool)return 'tool_receipt'
    if(narrative)return 'self_report'
    if(messages.length)return 'message'
    if(report)return 'worker_report'
    return 'self_report'
  }
  applyExperience({row,choiceBody,scopes,record,confidence,now,experience}) {
    const scopeKey=JSON.stringify(scopes)
    const stored=this.db.prepare('SELECT body FROM yoyo_motivation_affect WHERE scopes=?').get(scopeKey)
    const state=stored?JSON.parse(stored.body):{valence:0,mood:'calm',load:0,satiation:{},events:0,updatedAt:0}
    const satiation={...state.satiation}
    let count=satiation[row.activity_key]?.count??0
    if(record.repeatKey){
      const previous=satiation[row.activity_key]
      count=previous&&previous.key===record.repeatKey?previous.count+1:1
      satiation[row.activity_key]={key:record.repeatKey,count,at:now}
      const keys=Object.keys(satiation)
      if(keys.length>20)for(const key of keys.sort((a,b)=>(satiation[a].at??0)-(satiation[b].at??0)).slice(0,keys.length-20))delete satiation[key]
    }
    const effort=EFFORT[choiceBody.expected?.effort]??0.2
    state.load=round(choiceBody.kind==='rest'?clamp(state.load-0.3,0,1):clamp(state.load+effort,0,1))
    state.valence=round(clamp(state.valence*0.7+LIKED[record.liked]*0.3,-1,1))
    state.mood=state.load>=0.75&&record.liked==='disliked'?'frustrated':state.valence>=0.35?'pleased':state.valence<=-0.35?'uneasy':'calm'
    state.satiation=satiation;state.events=(state.events??0)+1;state.updatedAt=now
    this.db.prepare('INSERT INTO yoyo_motivation_affect(scopes,body,updated_at) VALUES(?,?,?) ON CONFLICT(scopes) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(scopeKey,JSON.stringify(state),now)
    const continuedValue=this.discount(count)
    if(record.credit!=='observed')return {state,continuedValue,preference:null,revision:null}
    const result=this.revisePreference({row,choiceBody,scopes,record,confidence,now,experience,satiationCount:Math.max(0,count-1)})
    return {state,continuedValue,preference:result.preference,revision:result.revision}
  }

  // Host-side bounded update. A change that contradicts an already stable
  // preference, or a later counterexample, is only proposed: the subject has to
  // accept it through self_preferences.
  revisePreference({row,choiceBody,scopes,record,confidence,now,experience,satiationCount=0,weight:weightOverride,alwaysPropose=false}) {
    const scopesKey=JSON.stringify(scopes),context=choiceBody.context??''
    const stored=this.db.prepare('SELECT * FROM yoyo_motivation_preferences WHERE activity_key=? AND context=? AND scopes=?').get(row.activity_key,context,scopesKey)
    const base=stored?JSON.parse(stored.body):emptyPreference()
    const next={...base,evidence:[...base.evidence].slice(-11),counter:[...base.counter].slice(-11),window:{...base.window}}
    if(now-next.window.since>3600000)next.window={since:now,delta:0}
    const weight=weightOverride??WEIGHT[confidence]??1
    const sign=LIKED[record.liked]
    const delta=0.18*weight*sign*(1-Math.min(0.6,0.15*(satiationCount??0)))
    let wantingDelta=0
    const expected=LEVEL_VALUE[choiceBody.expected?.expectedPleasure]
    if(expected!==undefined){if(expected>=0.6&&sign<0)wantingDelta=-0.08*weight;else if(expected<=0.3&&sign>0)wantingDelta=0.06*weight}
    next.samples=base.samples+1
    next.note=record.explanation?record.explanation.slice(0,300):base.note
    next.evidence.push({experience,liked:record.liked,at:now})
    if(sign<0)next.counter.push({experience,liked:record.liked,at:now})
    const opposite=base.stable&&base.liking*delta<0&&Math.abs(base.liking)>=0.3
    if((alwaysPropose&&stored)||opposite){
      const after={...next,samples:base.samples,stable:base.stable,evidence:[...base.evidence],
        wanting:round(clamp(base.wanting+wantingDelta,-1,1)),liking:round(clamp(base.liking+delta,-1,1)),pending:true}
      const id=this.insertRevision({preferenceId:stored.id,activityKey:row.activity_key,context,scopes:scopesKey,
        before:base,after,basis:'experience:'+experience,confidence,state:'proposed',experience,now})
      return {preference:null,revision:this.revisionView(this.db.prepare('SELECT * FROM yoyo_motivation_revisions WHERE id=?').get(id))}
    }
    const remaining=this.maxPerHour-Math.abs(next.window.delta)
    if(remaining<0.005){
      const id=this.insertRevision({preferenceId:stored?.id??null,activityKey:row.activity_key,context,scopes:scopesKey,
        before:base,after:{...base},basis:'experience:'+experience,confidence,state:'withheld',reason:'一小时内偏好变化已达上限',experience,now})
      return {preference:stored?{id:stored.id,activity:row.activity,context,liking:base.liking,wanting:base.wanting,samples:base.samples,stable:base.stable}:null,
        revision:this.revisionView(this.db.prepare('SELECT * FROM yoyo_motivation_revisions WHERE id=?').get(id))}
    }
    const limits=next.samples<3?[-0.25,0.5]:[-1,1]
    next.liking=round(clamp(base.liking+delta,limits[0],limits[1]))
    next.wanting=round(clamp(base.wanting+wantingDelta,-1,1))
    next.window.delta=round(next.window.delta+delta)
    next.stable=next.samples>=3&&Math.abs(next.liking)>=STABLE
    let preferenceId=stored?.id??null
    if(stored)this.db.prepare('UPDATE yoyo_motivation_preferences SET body=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(next),now,stored.id)
    else preferenceId=Number(this.db.prepare('INSERT INTO yoyo_motivation_preferences(activity,activity_key,context,body,scopes,version,updated_at) VALUES(?,?,?,?,?,1,?)')
      .run(row.activity,row.activity_key,context,JSON.stringify(next),scopesKey,now).lastInsertRowid)
    const revisionId=this.insertRevision({preferenceId,activityKey:row.activity_key,context,scopes:scopesKey,before:base,after:next,
      basis:'experience:'+experience,confidence,state:'applied',experience,now})
    return {preference:{id:preferenceId,activity:row.activity,context,liking:next.liking,wanting:next.wanting,samples:next.samples,stable:next.stable},
      revision:{id:revisionId,state:'applied',change:{liking:round(next.liking-base.liking),wanting:round(next.wanting-base.wanting)}}}
  }
  insertRevision({preferenceId,activityKey,context,scopes,before,after,basis,confidence,state,reason,experience,now}) {
    return Number(this.db.prepare('INSERT INTO yoyo_motivation_revisions(preference_id,activity_key,context,before,after,basis,confidence,state,reason,experience_id,scopes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(preferenceId,activityKey,context,JSON.stringify(before),JSON.stringify(after),basis,confidence,state,reason??null,experience??null,scopes,now).lastInsertRowid)
  }

  // ---- explicit preference maintenance -----------------------------------
  preferences(viewId,args={}) {
    const view=this.data.view(viewId)
    if(args.revision!==undefined)return this.decide(view,args)
    if(args.revert!==undefined)return this.revert(view,args)
    if(args.activity!==undefined)return this.propose(view,args)
    const revisions=this.db.prepare(`SELECT r.* FROM yoyo_motivation_revisions r WHERE ${this.visible('r')} ORDER BY r.id DESC LIMIT 10`)
      .all(JSON.stringify(view.scopes)).map(row=>this.revisionView(row))
    return {preferences:this.preferenceList(view),proposals:this.proposals(view),revisions}
  }
  decide(view,args) {
    const row=this.db.prepare('SELECT * FROM yoyo_motivation_revisions WHERE id=?').get(args.revision)
    if(!row||!JSON.parse(row.scopes).every(s=>mayRead(view,s)))throw Error('修订不在当前资料范围')
    if(row.state!=='proposed')throw Error('该修订已处理')
    const decision=option(args.decision,['apply','reject'],'修订决定')
    if(!decision)throw Error('需要选择接受或拒绝')
    const reason=optionalText(args.reason,1000,'理由'),now=Date.now()
    if(decision==='reject'){
      this.db.prepare("UPDATE yoyo_motivation_revisions SET state='rejected',reason=?,decided_at=? WHERE id=?").run(reason,now,row.id)
      return {id:row.id,state:'rejected',message:'修订已拒绝；原偏好保持不变。'}
    }
    const preference=row.preference_id?this.db.prepare('SELECT * FROM yoyo_motivation_preferences WHERE id=?').get(row.preference_id):null
    if(!preference)throw Error('偏好记录已不存在，请重新评价')
    if(preference.updated_at>row.created_at)throw Error('偏好已有更新，请基于当前偏好重新评价')
    const after=JSON.parse(row.after)
    const limits=Number.isInteger(after.samples)&&after.samples>=3?[-1,1]:[-0.25,0.5]
    after.liking=round(clamp(after.liking,limits[0],limits[1]))
    after.wanting=round(clamp(after.wanting,-1,1))
    after.stable=(after.samples??0)>=3&&Math.abs(after.liking)>=STABLE
    delete after.pending
    this.db.prepare('UPDATE yoyo_motivation_preferences SET body=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(after),now,preference.id)
    this.db.prepare("UPDATE yoyo_motivation_revisions SET state='applied',reason=?,decided_at=? WHERE id=?").run(reason,now,row.id)
    return {id:row.id,state:'applied',liking:after.liking,wanting:after.wanting,stable:after.stable}
  }
  revert(view,args) {
    const row=this.db.prepare('SELECT * FROM yoyo_motivation_revisions WHERE id=?').get(args.revert)
    if(!row||!JSON.parse(row.scopes).every(s=>mayRead(view,s)))throw Error('修订不在当前资料范围')
    if(row.state!=='applied'||!row.preference_id)throw Error('只能撤销已应用到偏好的修订')
    const latest=this.db.prepare("SELECT max(id) id FROM yoyo_motivation_revisions WHERE preference_id=? AND state='applied'").get(row.preference_id).id
    if(latest!==row.id)throw Error('只能撤销最近一次已应用的修订')
    const preference=this.db.prepare('SELECT * FROM yoyo_motivation_preferences WHERE id=?').get(row.preference_id)
    if(!preference)throw Error('偏好记录不存在')
    const before=JSON.parse(row.before??'{}'),current=JSON.parse(preference.body),now=Date.now()
    const restored={...current,liking:before.liking??current.liking,wanting:before.wanting??current.wanting,
      samples:before.samples??current.samples,note:before.note??current.note,
      stable:(before.samples??current.samples)>=3&&Math.abs(before.liking??current.liking)>=STABLE,
      counter:[...current.counter,{reverted:row.id,at:now}]}
    this.db.prepare('UPDATE yoyo_motivation_preferences SET body=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(restored),now,preference.id)
    this.db.prepare("UPDATE yoyo_motivation_revisions SET state='reverted',reason=?,decided_at=? WHERE id=?").run(optionalText(args.reason,1000,'理由'),now,row.id)
    this.insertRevision({preferenceId:preference.id,activityKey:row.activity_key,context:row.context,scopes:row.scopes,before:current,after:restored,
      basis:'revert:'+row.id,confidence:row.confidence,state:'applied',now})
    return {id:row.id,state:'reverted',liking:restored.liking,wanting:restored.wanting}
  }
  propose(view,args) {
    const activity=boundedText(args.activity,120,'活动'),activityKey=keyOf(activity)
    const context=optionalText(args.context,120,'情境'),scopesKey=this.scopeKey(view)
    const evidence=(args.evidence??[]).slice(0,10)
    if(!evidence.length)throw Error('提出偏好修订需要引用当前范围内的实际经历')
    if(typeof args.liking!=='number'&&typeof args.wanting!=='number')throw Error('需要给出想要的调整方向')
    for(const id of evidence){
      const record=this.db.prepare('SELECT scopes,activity_key FROM yoyo_motivation_experiences WHERE id=?').get(id)
      if(!record||!JSON.parse(record.scopes).every(s=>mayRead(view,s)))throw Error('修订依据不在当前资料范围')
      if(record.activity_key!==activityKey)throw Error('修订依据属于其他活动')
      if(this.db.prepare("SELECT 1 FROM yoyo_motivation_revisions WHERE basis=? AND state IN ('applied','proposed')").get('manual:'+id))throw Error('这条经历已经用于偏好修订')
    }
    const stored=this.db.prepare('SELECT * FROM yoyo_motivation_preferences WHERE activity_key=? AND context=? AND scopes=?').get(activityKey,context,scopesKey)
    const base=stored?JSON.parse(stored.body):emptyPreference()
    const step=0.12,now=Date.now()
    const next={...base,evidence:[...base.evidence],counter:[...base.counter],window:{...base.window}}
    next.samples=base.samples+1
    const limits=next.samples<3?[-0.25,0.5]:[-1,1]
    if(typeof args.liking==='number')next.liking=round(clamp(base.liking+clamp(args.liking-base.liking,-step,step),limits[0],limits[1]))
    if(typeof args.wanting==='number')next.wanting=round(clamp(base.wanting+clamp(args.wanting-base.wanting,-step,step),-1,1))
    next.note=optionalText(args.reason,300,'理由')||base.note
    next.stable=next.samples>=3&&Math.abs(next.liking)>=STABLE
    next.evidence.push({experience:evidence[0],manual:true,at:now})
    let preferenceId=stored?.id??null
    if(stored)this.db.prepare('UPDATE yoyo_motivation_preferences SET body=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(next),now,stored.id)
    else preferenceId=Number(this.db.prepare('INSERT INTO yoyo_motivation_preferences(activity,activity_key,context,body,scopes,version,updated_at) VALUES(?,?,?,?,?,1,?)')
      .run(activity,activityKey,context,JSON.stringify(next),scopesKey,now).lastInsertRowid)
    this.insertRevision({preferenceId,activityKey,context,scopes:scopesKey,before:base,after:next,basis:'manual:'+evidence[0],
      confidence:'self_report',state:'applied',now})
    return {preference:{id:preferenceId,activity,context,liking:next.liking,wanting:next.wanting,samples:next.samples,stable:next.stable},
      message:'偏好按一次有界的手动修订更新；依据是已记录的经历，仍属于主体自己的判断，单次幅度有限。'}
  }

  // Compact view for the native dynamic state. It survives compaction as a
  // short summary instead of replaying the full history.
  summary(view) {
    if(!view)return null
    const affect=this.affect(view),open=this.openChoices(view),preferences=this.preferenceList(view)
    return {mode:this.mode,mood:affect.mood,load:affect.load,
      current:open[0]?{activity:open[0].activity,chosen:open[0].chosen,kind:open[0].kind,returnWhen:open[0].returnWhen}:null,
      preferences:preferences.slice(0,5).map(p=>({activity:p.activity,context:p.context,liking:p.liking,wanting:p.wanting,stable:p.stable})),
      recent:this.recentExperiences(view,3).map(e=>({activity:e.activity,liked:e.liked,worth:e.worth,credit:e.credit})),
      proposals:this.proposals(view).length}
  }

  register(define) {
    define('self_options','查看当前情绪基调、模拟负荷、重复饱和、相关偏好、待定修订和未完成的选择。此处不生成任务，也不改变权限、提醒或发信。',
      {activity:{type:'string',maxLength:120}},[],async(args,exec,key,view)=>this.options(view.id,args))
    define('self_choose','记录少量候选和你的选择、理由、期待、投入预算与继续/退出条件。可以只是轻量记录，也可以选择休息；普通小决定不必填满每一项。',
      {activity:{type:'string',maxLength:120},context:{type:'string',maxLength:120},concern:{type:'integer',minimum:1},
        candidates:{type:'array',maxItems:6,items:{type:'object',additionalProperties:false,properties:{label:{type:'string',minLength:1,maxLength:120},appeal:{type:'string',enum:LEVELS},expectedPleasure:{type:'string',enum:LEVELS},expectedSatisfaction:{type:'string',enum:LEVELS},effort:{type:'string',enum:LEVELS},uncertainty:{type:'string',enum:LEVELS},repeated:{type:'boolean'},relation:{type:'string',maxLength:300},commitment:{type:'string',maxLength:300},continueWhen:{type:'string',maxLength:300},exitWhen:{type:'string',maxLength:300}},required:['label']}},
        chosen:{type:'string',minLength:1,maxLength:120},rest:{type:'boolean'},reason:{type:'string',maxLength:1000},
        confidence:{type:'string',enum:LEVELS},
        budget:{type:'object',additionalProperties:false,properties:{steps:{type:'integer',minimum:1,maximum:200},minutes:{type:'integer',minimum:1,maximum:1440}}},
        returnWhen:{type:'string',maxLength:300}},['activity','chosen'],async(args,exec,key,view)=>this.choose(view.id,args))
    define('self_appraise','事件之后对照期待记录实际感受：outcome 写实际发生了什么，liked 写喜欢/无感/不喜欢，worthAfter 写事后是否值得。有真实消息或工具回执会作为证据；只靠自述或执行者转述不会提高满足。同一事件只计一次。',
      {choice:{type:'integer',minimum:1},outcome:{type:'string',minLength:1,maxLength:1000},liked:{type:'string',enum:['liked','neutral','disliked']},
        worthAfter:{type:'string',enum:WORTH},progress:{type:'string',enum:PROGRESS},explanation:{type:'string',maxLength:1500},
        confidence:{type:'string',enum:LEVELS},repeatKey:{type:'string',maxLength:120},
        evidence:{type:'object',additionalProperties:false,properties:{messages:{type:'array',maxItems:10,items:{type:'integer',minimum:1}},receipts:{type:'array',maxItems:10,items:{type:'string',maxLength:500}}}},
        laterOf:{type:'integer',minimum:1},end:{type:'boolean'}},['choice','outcome','liked'],async(args,exec,key,view)=>this.appraise(view.id,args))
    define('self_preferences','查看当前范围的偏好与修订链；用 revision+decision 接受或拒绝待定修订，用 revert 撤销最近一次已应用的修订，或用 activity+证据+方向提出一次有界的手动修订。数值不能任意指定或清零。',
      {revision:{type:'integer',minimum:1},decision:{type:'string',enum:['apply','reject']},reason:{type:'string',maxLength:1000},
        revert:{type:'integer',minimum:1},activity:{type:'string',maxLength:120},context:{type:'string',maxLength:120},
        wanting:{type:'number',minimum:-1,maximum:1},liking:{type:'number',minimum:-1,maximum:1},
        evidence:{type:'array',maxItems:10,items:{type:'integer',minimum:1}}},[],async(args,exec,key,view)=>this.preferences(view.id,args))
  }
}
