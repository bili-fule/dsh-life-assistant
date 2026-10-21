import { randomUUID, createHash } from 'node:crypto'
import { boundedText, mayRead, sourceScopes } from './scope.mjs'

// Each role is a fixed set of host methods. A task may narrow its role, never
// widen it; the model cannot name a tool outside its role.
export const ROLE_TOOLS={
  chat:['read','wait','recall','send','report','evidence','board','remember','pack','usage','step','ask','answer','events'],
  research:['web','report','evidence','board','remember','pack','usage','step','events'],
  reader:['read','recall','report','evidence','board','remember','pack','usage','step','events'],
  verify:['board','recall','report','evidence','pack','usage','step','events'],
  // Engineering runs code in the isolated runner and reports back; it cannot talk
  // to anyone, cannot read a private window and cannot reach the debug container.
  engineer:['execute','job','report','evidence','board','remember','pack','usage','step','events'],
  // A peer works with nearly the subject's own reach (same reads, searches, files,
  // public browsing, memory tools and code runner). It still has no control plane:
  // no orchestration of other executors, no attention/focus, no own-state or
  // settings tools, and no debug container. The subject keeps cancelling, steering,
  // taking over and bounding it.
  peer:['read','wait','search','message','file','attachment','forward','recall','web','execute','job','send',
    'report','evidence','board','remember','pack','memory_recall','memory_inspect','memory_propose','memory_segments','memory_generalize','usage','step','ask','answer','events'],
}

// A branch talks to its siblings and to the subject through durable events, not
// through a second message system: reports, findings and steers are recorded as
// events so the same rows answer "what did the other branch learn, when".
export const EVENT_KINDS=['finding','question','answer','progress','direction_changed','blocked','completed','cancel']

const WORKER_CLAIM_TYPES=['fact','knowledge','preference','procedure','self']

// Host-only API. Agent identity, view and lease tokens must never come from
// model-supplied tool arguments. No production worker is enabled by this store.
export class TeamStore {
  constructor(social, clock=Date.now) {
    this.social=social;this.db=social.db;this.clock=clock
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_team_tasks(
        id TEXT PRIMARY KEY, run_key TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
        goal TEXT NOT NULL, view_id TEXT NOT NULL, state TEXT NOT NULL,
        agent_id TEXT UNIQUE, attempt INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_reports(
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_speakers(
        target TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT,
        generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, view_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_evidence(
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, scopes TEXT NOT NULL,
        kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_steers(
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL,
        created_at INTEGER NOT NULL, applied_at INTEGER, agent_id TEXT);
      CREATE TABLE IF NOT EXISTS yoyo_team_usage(
        task_id TEXT NOT NULL, attempt INTEGER NOT NULL, steps INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0, tokens_reported INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, PRIMARY KEY(task_id,attempt));
      CREATE TABLE IF NOT EXISTS yoyo_team_memory_candidates(
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, scopes TEXT NOT NULL,
        kind TEXT NOT NULL, claim_type TEXT, statement TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', claim_id INTEGER, decided_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_memory_packs(
        task_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL, clue TEXT NOT NULL,
        scopes TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_events(
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, topic TEXT NOT NULL,
        task_id TEXT, from_task TEXT, to_task TEXT, activity_id TEXT, kind TEXT NOT NULL,
        body TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', base_revision INTEGER,
        scopes TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        expires_at INTEGER, delivered_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS yoyo_team_cursors(
        task_id TEXT NOT NULL, topic TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, PRIMARY KEY(task_id,topic));
    `)
    const columns=this.db.prepare('PRAGMA table_info(yoyo_team_tasks)').all().map(column=>column.name)
    for(const [name,type] of [['failures','INTEGER NOT NULL DEFAULT 0'],['retry_at','INTEGER'],['renewed_at','INTEGER'],
      ['parent_id','TEXT'],['depends_on','TEXT'],['toolset','TEXT'],['authorization_version','INTEGER'],
      ['persona_version','INTEGER'],['max_steps','INTEGER'],['focus_key','TEXT'],['activity_id','TEXT']])
      if(!columns.includes(name))this.db.exec(`ALTER TABLE yoyo_team_tasks ADD COLUMN ${name} ${type}`)
    // A task now stores the window it works in, not the identity of the caller's
    // view object, so idempotency is compared on the window itself.
    this.db.exec("UPDATE yoyo_team_tasks SET focus_key=(SELECT coalesce(focus,'') FROM yoyo_views v WHERE v.id=yoyo_team_tasks.view_id) WHERE focus_key IS NULL")
    // Databases created before usage reporting was distinguished keep their rows;
    // an existing 0 simply means "not reported", which is what the flag defaults to.
    const usageColumns=this.db.prepare('PRAGMA table_info(yoyo_team_usage)').all().map(column=>column.name)
    if(!usageColumns.includes('tokens_reported')){
      this.db.exec('ALTER TABLE yoyo_team_usage ADD COLUMN tokens_reported INTEGER NOT NULL DEFAULT 0')
      // Older rows only ever recorded tokens after a real report, so a positive
      // count is evidence of reporting; zeros stay marked as not reported.
      this.db.exec('UPDATE yoyo_team_usage SET tokens_reported=1 WHERE tokens>0')
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {const result=fn();this.db.exec('COMMIT');return result}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  create({key,role,goal,viewId,expiresAt,parentId=null,dependsOn=null,toolset=null,maxSteps=null,activityId=null}) {
    if(!Object.keys(ROLE_TOOLS).includes(role))throw Error('未知执行角色')
    boundedText(key,300,'幂等键');goal=boundedText(goal,6000,'任务目标')
    let view=this.social.view(viewId)
    // chat, reader and peer work inside one window; research and verify never
    // imply a private window.
    if(['chat','reader'].includes(role)&&!view.focus)throw Error('该角色需要绑定窗口')
    // Public research and engineering must not carry private material into a
    // separate process, so they get their own public window instead of failing:
    // the subject keeps its own reading rights while the branch stays narrow.
    if(['research','engineer'].includes(role)&&view.scopes.some(s=>s!=='public')){view=this.social.publicView();viewId=view.id}
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock())throw Error('任务期限无效')
    let tools=null
    if(toolset!==null){
      if(!Array.isArray(toolset)||!toolset.length||toolset.length>ROLE_TOOLS[role].length||toolset.some(name=>!ROLE_TOOLS[role].includes(name)))throw Error('工具集必须属于该角色')
      tools=JSON.stringify([...new Set(toolset)])
    }
    if(maxSteps!==null&&(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>200))throw Error('任务步数上限无效')
    let depends=null
    if(dependsOn!==null){
      if(!Array.isArray(dependsOn)||!dependsOn.length||dependsOn.length>3||dependsOn.some(id=>typeof id!=='string'))throw Error('依赖任务无效')
      for(const id of dependsOn)this.inspect(id,viewId)
      depends=JSON.stringify([...new Set(dependsOn)])
    }
    if(parentId!==null)this.inspect(parentId,viewId)
    if(activityId!==null&&!this.social.activities(viewId).some(a=>a.activityId===activityId))throw Error('活动不存在或不在当前资料范围')
    const old=this.db.prepare('SELECT * FROM yoyo_team_tasks WHERE run_key=?').get(key)
    if(old){
      if(old.role!==role||old.goal!==goal||(old.focus_key??'')!==(view.focus??'')||old.expires_at!==expiresAt)throw Error('幂等键参数冲突')
      return old
    }
    // Snapshots make a stale authorisation or persona visible instead of implicit.
    const authorization=view.focus&&['chat','reader','peer'].includes(role)?this.social.target(view.focus,{approved:true}).version:null
    const persona=this.db.prepare('SELECT coalesce(max(id),0) id FROM yoyo_persona_versions').get().id
    const id=randomUUID()
    this.db.prepare('INSERT INTO yoyo_team_tasks(id,run_key,role,goal,view_id,state,expires_at,created_at,parent_id,depends_on,toolset,authorization_version,persona_version,max_steps,focus_key,activity_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,key,role,goal,viewId,'ready',expiresAt,this.clock(),parentId,depends,tools,authorization,persona,maxSteps,view.focus??'',activityId)
    if(activityId)this.social.linkActivity(activityId,'task',id)
    return this.inspect(id,viewId)
  }
  inspect(id,viewId) {
    const row=this.db.prepare('SELECT * FROM yoyo_team_tasks WHERE id=?').get(id)
    const reader=this.social.view(viewId)
    if(!row)throw Error('任务不存在')
    const source=this.social.view(row.view_id)
    if(!source.scopes.every(s=>mayRead(reader,s)))throw Error('任务不在当前资料范围')
    return row
  }
  overview() {
    // No goal, sender, window label or private report in the global envelope.
    return this.db.prepare(`SELECT t.id,t.role,t.state,t.expires_at,
      coalesce((SELECT sum(u.steps) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) steps,
      coalesce((SELECT sum(u.tokens) FROM yoyo_team_usage u WHERE u.task_id=t.id),0) tokens
      FROM yoyo_team_tasks t ORDER BY t.created_at DESC LIMIT 100`).all()
  }
  claim(id,agentId) {
    boundedText(agentId,160,'执行者')
    return this.transaction(()=>{
      const task=this.db.prepare("SELECT * FROM yoyo_team_tasks WHERE id=? AND state='ready'").get(id)
      if(!task||task.expires_at<=this.clock())throw Error('任务不可领取')
      const view=this.social.view(task.view_id)
      if(task.depends_on)for(const dependency of JSON.parse(task.depends_on)){
        const state=this.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(dependency)?.state
        if(state!=='completed')throw Error('依赖任务尚未完成')
      }
      if(['chat','reader','peer'].includes(task.role)){
        const target=this.social.target(view.focus,{approved:true})
        // The task carries the authorisation it was created under; a newer
        // version means the window changed and the old task must not continue.
        if(task.authorization_version!==null&&target.version!==task.authorization_version)throw Error('目标授权已变化，不能沿用旧任务')
        if(['chat','peer'].includes(task.role)){
          this.social.assertOutbound(view.scopes,view.focus)
          const speaker=this.db.prepare('SELECT * FROM yoyo_team_speakers WHERE target=?').get(view.focus)
          if(speaker&&speaker.expires_at>this.clock())throw Error('窗口已有发言者')
          this.speaker(view.focus,agentId,id,task.expires_at,view.id)
        }
      }
      this.db.prepare("UPDATE yoyo_team_tasks SET state='running',agent_id=?,attempt=attempt+1 WHERE id=?").run(agentId,id)
      return this.authority(agentId)
    })
  }
  authority(agentId) {
    const task=this.db.prepare("SELECT * FROM yoyo_team_tasks WHERE agent_id=? AND state IN ('running','waiting')").get(agentId)
    if(!task||task.expires_at<=this.clock())throw Error('执行者授权已失效')
    return {task,view:this.social.view(task.view_id)}
  }
  speaker(target,agentId,taskId,expiresAt,viewId) {
    this.db.prepare(`INSERT INTO yoyo_team_speakers VALUES(?,?,?,1,?,?)
      ON CONFLICT(target) DO UPDATE SET agent_id=excluded.agent_id,task_id=excluded.task_id,
      generation=generation+1,expires_at=excluded.expires_at,view_id=excluded.view_id`).run(target,agentId,taskId,expiresAt,viewId)
    return this.db.prepare('SELECT generation FROM yoyo_team_speakers WHERE target=?').get(target).generation
  }
  takeover(viewId,mainAgentId,expiresAt,target=null) {
    const view=this.social.view(viewId)
    const window=target??view.focus
    if(!window||!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock())throw Error('接管参数无效')
    this.social.assertOutbound(view.scopes,window)
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT task_id FROM yoyo_team_speakers WHERE target=?').get(window)
      if(previous?.task_id)this.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE id=?").run(previous.task_id)
      return this.speaker(window,mainAgentId,null,expiresAt,view.id)
    })
  }
  authorizeSend(agentId,target,generation) {
    const lease=this.db.prepare('SELECT * FROM yoyo_team_speakers WHERE target=?').get(target)
    this.social.target(target,{approved:true})
    if(!lease||lease.agent_id!==agentId||lease.generation!==generation||lease.expires_at<=this.clock())throw Error('发言租约已失效')
    this.social.view(lease.view_id)
    if(lease.task_id){
      const {view}=this.authority(agentId)
      if(view.focus!==target)throw Error('执行者不能跨窗口发送')
      this.social.assertOutbound(view.scopes,target)
    }
    return true
  }
  report(agentId,body) {
    const {task,view}=this.authority(agentId)
    body=boundedText(body,12000,'进展')
    this.db.prepare('INSERT INTO yoyo_team_reports(task_id,attempt,body,created_at) VALUES(?,?,?,?)').run(task.id,task.attempt,body,this.clock())
    // Progress is shared while the task is still running, not saved for the end.
    this.publishEvent({fromTask:task.id,activityId:task.activity_id??null,kind:'progress',body:body.slice(0,4000),viewId:view.id})
    return {recorded:true}
  }
  reports(id,viewId) {
    this.inspect(id,viewId)
    return this.db.prepare('SELECT id,body,created_at FROM yoyo_team_reports WHERE task_id=? ORDER BY id DESC LIMIT 50').all(id)
  }
  // ---------------------------------------------------------------- events
  // Durable, at-least-once, deduplicated. The database is the authority and the
  // per-task cursor is what makes "already delivered" different from "written".
  publishEvent({fromTask=null,toTask=null,activityId=null,kind,body,ref='',baseRevision=null,dedupeKey=null,expiresAt=null,viewId,now=this.clock()}) {
    if(!EVENT_KINDS.includes(kind))throw Error('事件类型无效')
    body=boundedText(body,4000,'事件内容')
    if(typeof ref!=='string'||ref.length>200)throw Error('事件引用无效')
    if(expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<=now))throw Error('事件期限无效')
    const view=this.social.view(viewId)
    // A branch may only address a task it could inspect, and the subject only
    // addresses tasks it can see. The topic is host-decided, never model-decided.
    if(toTask)this.inspect(toTask,viewId)
    const topic=toTask?'task:'+toTask:activityId?'activity:'+activityId:'subject'
    const key=dedupeKey??('evt-'+createHash('sha256').update(JSON.stringify([fromTask,toTask,activityId,kind,ref,body])).digest('hex').slice(0,32))
    const eventId=randomUUID()
    const result=this.db.prepare('INSERT OR IGNORE INTO yoyo_team_events(event_id,topic,task_id,from_task,to_task,activity_id,kind,body,ref,base_revision,scopes,dedupe_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(eventId,topic,fromTask,fromTask,toTask,activityId,kind,body,ref,baseRevision,JSON.stringify(this.social.recordScopes(view)),String(key),now,expiresAt)
    if(!result.changes)return {duplicate:true,eventId:this.db.prepare('SELECT event_id FROM yoyo_team_events WHERE dedupe_key=?').get(String(key)).event_id}
    return {eventId,id:Number(result.lastInsertRowid),topic,kind,at:now}
  }
  // Which topics a branch listens to: its own mailbox, the activity it belongs
  // to, and the subject-wide channel.
  subscriptions(taskId) {
    const row=this.db.prepare('SELECT id,activity_id FROM yoyo_team_tasks WHERE id=?').get(taskId)
    const topics=['task:'+taskId,'subject']
    if(row?.activity_id)topics.push('activity:'+row.activity_id)
    return topics
  }
  pendingEvents(taskId,{limit=8,now=this.clock()}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('事件条数无效')
    const rows=[]
    for(const topic of this.subscriptions(taskId)){
      const cursor=this.db.prepare('SELECT cursor FROM yoyo_team_cursors WHERE task_id=? AND topic=?').get(taskId,topic)?.cursor??0
      for(const row of this.db.prepare("SELECT * FROM yoyo_team_events WHERE topic=? AND id>? AND (from_task IS NULL OR from_task<>?) AND (expires_at IS NULL OR expires_at>?) ORDER BY id LIMIT ?").all(topic,cursor,taskId,now,limit)){
        rows.push({...row,cursor})
      }
    }
    return rows.sort((a,b)=>a.id-b.id).slice(0,limit)
  }
  // Delivery is a cursor move, so the same event is never handed over twice and a
  // restart resumes from the last acknowledged position.
  acknowledgeEvents(taskId,events,now=this.clock()) {
    for(const event of events){
      const through=event.id
      this.db.prepare('INSERT INTO yoyo_team_cursors(task_id,topic,cursor,updated_at) VALUES(?,?,?,?) ON CONFLICT(task_id,topic) DO UPDATE SET cursor=max(cursor,excluded.cursor),updated_at=excluded.updated_at').run(taskId,event.topic,through,now)
      this.db.prepare('UPDATE yoyo_team_events SET delivered_count=delivered_count+1 WHERE id=?').run(through)
    }
    return events.length
  }
  drainEvents(taskId,{limit=8,now=this.clock()}={}) {
    const events=this.pendingEvents(taskId,{limit,now})
    if(events.length)this.acknowledgeEvents(taskId,events,now)
    return events.map(({event_id,kind,body,ref,base_revision,from_task,to_task,created_at})=>({eventId:event_id,kind,body,ref,baseRevision:base_revision,from:from_task,to:to_task,at:created_at}))
  }
  // Branch-to-branch question and answer, with the correlation kept in `ref` so an
  // answer can be matched to its question without a relay through the subject.
  ask(fromTask,{toTask,question,baseRevision=null,expiresAt=null,viewId}) {
    const asked=this.publishEvent({fromTask,toTask,kind:'question',body:question,baseRevision,expiresAt,viewId})
    if(asked.duplicate)return {...asked,question:this.db.prepare('SELECT body FROM yoyo_team_events WHERE event_id=?').get(asked.eventId).body}
    return {...asked,question}
  }
  answer(fromTask,{questionEventId,answer,viewId}) {
    if(typeof questionEventId!=='string'||!questionEventId)throw Error('问题编号无效')
    const question=this.db.prepare("SELECT * FROM yoyo_team_events WHERE event_id=? AND kind='question'").get(questionEventId)
    if(!question)throw Error('问题不存在')
    if(question.to_task&&question.to_task!==fromTask)throw Error('这个问题不是发给你的')
    return this.publishEvent({fromTask,toTask:question.from_task??null,kind:'answer',body:answer,ref:questionEventId,viewId})
  }
  // Subject-side view: what happened under one activity or task, and which
  // questions are still open.
  activityEvents(viewId,{activityId=null,taskId=null,after=0,limit=20}={}) {
    const view=this.social.view(viewId)
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50)throw Error('事件范围无效')
    const rows=this.db.prepare('SELECT * FROM yoyo_team_events e WHERE e.id>? AND (? IS NULL OR e.activity_id=?) AND (? IS NULL OR e.task_id=?) AND NOT EXISTS(SELECT 1 FROM json_each(e.scopes) s WHERE s.value NOT IN(SELECT value FROM json_each(?))) ORDER BY e.id LIMIT ?')
      .all(after,activityId,activityId,taskId,taskId,JSON.stringify(view.scopes),limit)
    return rows.map(({event_id,kind,body,ref,base_revision,from_task,to_task,activity_id,created_at,delivered_count})=>({eventId:event_id,kind,body,ref,baseRevision:base_revision,from:from_task,to:to_task,activityId:activity_id,at:created_at,delivered:delivered_count}))
  }
  openQuestions(viewId,{activityId=null}={}) {
    const view=this.social.view(viewId)
    return this.db.prepare("SELECT q.event_id,q.body,q.from_task,q.to_task,q.created_at FROM yoyo_team_events q WHERE q.kind='question' AND NOT EXISTS(SELECT 1 FROM yoyo_team_events a WHERE a.kind='answer' AND a.ref=q.event_id) AND (? IS NULL OR q.activity_id=?) AND NOT EXISTS(SELECT 1 FROM json_each(q.scopes) s WHERE s.value NOT IN(SELECT value FROM json_each(?))) ORDER BY q.id DESC LIMIT 20")
      .all(activityId,activityId,JSON.stringify(view.scopes))
      .map(r=>({eventId:r.event_id,question:r.body,from:r.from_task,to:r.to_task,at:r.created_at}))
  }
  // A worker may publish what it actually found to a task-scoped board. The
  // board inherits the task's source scopes, so a private window's evidence can
  // never surface in another window or in the public view.
  evidence(agentId,{kind='finding',body,source=''}) {
    const {task,view}=this.authority(agentId)
    if(!['finding','source','excerpt'].includes(kind))throw Error('证据类型无效')
    body=boundedText(body,4000,'证据')
    source=source===undefined||source===null||source===''?'':boundedText(String(source),500,'来源标注')
    // The same finding repeated is still one piece of evidence, never two votes.
    const same=this.db.prepare('SELECT id,kind FROM yoyo_team_evidence WHERE task_id=? AND source=? AND body=?').get(task.id,source,body)
    if(same)return {id:same.id,taskId:task.id,kind:same.kind,shared:true,duplicate:true}
    // A different finding from an already cited source is kept, but flagged, so
    // a disagreement between pages cannot quietly turn into agreement.
    const conflict=source!==''&&!!this.db.prepare('SELECT 1 FROM yoyo_team_evidence WHERE task_id=? AND source=? AND body<>?').get(task.id,source,body)
    const id=Number(this.db.prepare('INSERT INTO yoyo_team_evidence(task_id,attempt,scopes,kind,source,body,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(task.id,task.attempt,JSON.stringify(sourceScopes(view.scopes)),kind,source,body,this.clock()).lastInsertRowid)
    // A finding becomes an event its siblings can act on before the task ends;
    // an excerpt stays on the board until someone asks for it.
    if(kind==='finding')this.publishEvent({fromTask:task.id,activityId:task.activity_id??null,kind:'finding',body,ref:source,viewId:view.id})
    return {id,taskId:task.id,kind,shared:true,conflict}
  }
  board(viewId,{taskId,limit=20}={}) {
    const view=this.social.view(viewId)
    if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('证据条数无效')
    if(taskId!==undefined)this.inspect(taskId,viewId)
    const filter="NOT EXISTS(SELECT 1 FROM json_each(e.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?)))"
    const rows=this.db.prepare(`SELECT e.id,e.task_id,e.kind,e.source,e.body,e.created_at FROM yoyo_team_evidence e
      WHERE ${filter}${taskId!==undefined?' AND e.task_id=?':''} ORDER BY e.id DESC LIMIT ?`)
      .all(...(taskId!==undefined?[JSON.stringify(view.scopes),taskId,limit]:[JSON.stringify(view.scopes),limit]))
    return rows
  }
  // A later task often needs what an earlier task really read. Retrieval answers
  // from the same visible-scope rule as the board, so it can never reach another
  // window's material, and it returns excerpts rather than promising conclusions.
  searchEvidence(viewId,{query,kind,limit=10}={}) {
    const view=this.social.view(viewId)
    if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('证据条数无效')
    if(kind!==undefined&&!['finding','source','excerpt'].includes(kind))throw Error('证据类型无效')
    const wanted=String(query??'').toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(word=>word.length>1).slice(0,8)
    if(!wanted.length)throw Error('需要检索线索')
    const filter="NOT EXISTS(SELECT 1 FROM json_each(e.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?)))"
    const rows=this.db.prepare(`SELECT e.id,e.task_id,e.kind,e.source,e.body,e.created_at FROM yoyo_team_evidence e
      WHERE ${filter}${kind!==undefined?' AND e.kind=?':''} ORDER BY e.id DESC LIMIT 300`)
      .all(...(kind!==undefined?[JSON.stringify(view.scopes),kind]:[JSON.stringify(view.scopes)]))
    return rows.map(row=>{
      const text=(row.source+' '+row.body).toLowerCase()
      const score=wanted.filter(term=>text.includes(term)).length
      return {id:row.id,taskId:row.task_id,kind:row.kind,source:row.source,body:row.body.slice(0,400),createdAt:row.created_at,score}
    }).filter(row=>row.score>0).sort((left,right)=>right.score-left.score||right.id-left.id).slice(0,limit)
  }
  // The same page read by two tasks can end up described differently. The
  // registry is computed from the evidence rows themselves, so it cannot drift
  // from what was actually recorded, and it stays inside the visible scopes.
  sourceRegistry(viewId,{limit=20}={}) {
    const view=this.social.view(viewId)
    if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('来源条数无效')
    const filter="NOT EXISTS(SELECT 1 FROM json_each(e.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?)))"
    return this.db.prepare(`SELECT e.source source,count(*) readings,count(DISTINCT e.body) variants,
      group_concat(DISTINCT e.task_id) tasks,max(e.created_at) lastAt
      FROM yoyo_team_evidence e WHERE ${filter} AND e.source<>''
      GROUP BY e.source,e.scopes ORDER BY variants DESC,readings DESC,lastAt DESC LIMIT ?`)
      .all(JSON.stringify(view.scopes),limit).map(row=>({source:row.source,readings:row.readings,
        distinct:row.variants,conflict:row.variants>1,tasks:String(row.tasks??'').split(',').filter(Boolean),lastAt:row.lastAt}))
  }
  // ---- memory candidates -------------------------------------------------
  // A worker may hand over what it thinks is worth remembering. This is a
  // candidate, never a memory: it stays pending until the subject, back in its
  // own view, re-checks the originals and decides. A worker's window can
  // establish what was said, not who someone really is, so identity claims and
  // expression habits are refused outright.
  memoryCandidate(agentId,{kind='claim',statement,claimType,context='',evidence={}}) {
    const {task,view}=this.authority(agentId)
    if(!['episode','claim'].includes(kind))throw Error('候选类型无效')
    const text=boundedText(statement,1200,'候选记忆')
    if(kind==='claim'&&!WORKER_CLAIM_TYPES.includes(claimType))
      throw Error('执行者不能提交关于某人身份或表达习惯的候选；这类记忆需要同一真实身份的原文')
    const note=context===undefined||context===null||context===''?'':boundedText(String(context),300,'补充')
    const sources={messages:[],receipts:[],documents:[]}
    for(const key of ['messages','receipts','documents']){
      const list=evidence?.[key]
      if(list===undefined||list===null)continue
      if(!Array.isArray(list)||list.length>10)throw Error('候选来源无效')
      sources[key]=list.map(item=>{
        if(key==='receipts'){
          if(typeof item!=='string'||!item)throw Error('回执编号无效')
          return boundedText(item,500,'回执编号')
        }
        const id=Number(item)
        if(!Number.isSafeInteger(id)||id<1)throw Error('来源编号无效')
        return id
      })
    }
    if(!sources.messages.length&&!sources.receipts.length&&!sources.documents.length)
      throw Error('候选记忆需要说明依据：真实消息编号、工具回执或网页编号')
    const body={context:note,claimType:claimType??null,evidence:sources}
    const stored=JSON.stringify(body)
    const duplicate=this.db.prepare("SELECT id FROM yoyo_team_memory_candidates WHERE task_id=? AND kind=? AND statement=? AND body=? AND state='pending'")
      .get(task.id,kind,text,stored)
    if(duplicate)return {id:duplicate.id,state:'pending',duplicate:true,message:'同样的候选已经排队，等主体回到这个范围再决定，不用重复提交。'}
    const id=Number(this.db.prepare('INSERT INTO yoyo_team_memory_candidates(task_id,attempt,scopes,kind,claim_type,statement,body,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(task.id,task.attempt,JSON.stringify(sourceScopes(view.scopes)),kind,claimType??null,text,stored,'pending',this.clock()).lastInsertRowid)
    return {id,kind,state:'pending',message:'候选已排队。它不是记忆：主体回到这个范围核对原文之后才会决定是否采纳。'}
  }
  memoryCandidates(viewId,{state='pending',limit=20}={}) {
    const view=this.social.view(viewId)
    if(!['pending','accepted','rejected'].includes(state))throw Error('候选状态无效')
    if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('候选条数无效')
    const filter="NOT EXISTS(SELECT 1 FROM json_each(c.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?)))"
    return this.db.prepare(`SELECT c.* FROM yoyo_team_memory_candidates c WHERE ${filter} AND c.state=? ORDER BY c.id DESC LIMIT ?`)
      .all(JSON.stringify(view.scopes),state,limit).map(row=>this.candidateShape(row))
  }
  candidateShape(row) {
    const body=JSON.parse(row.body)
    return {id:row.id,taskId:row.task_id,kind:row.kind,claimType:row.claim_type,statement:row.statement,
      context:body.context??'',evidence:body.evidence??{messages:[],receipts:[],documents:[]},
      decision:body.decision??null,state:row.state,claimId:row.claim_id??null,createdAt:row.created_at}
  }
  candidate(viewId,id) {
    const view=this.social.view(viewId)
    const row=this.db.prepare('SELECT * FROM yoyo_team_memory_candidates WHERE id=?').get(id)
    if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('候选记忆不在当前资料范围')
    return this.candidateShape(row)
  }
  // A pack is a small, scoped selection of memory summaries handed to one task.
  // Summaries only: originals still need team_recall or the evidence board, and
  // the pack can never carry another window's material.
  writeMemoryPack(taskId,viewId,{clue,items}) {
    const view=this.social.view(viewId)
    const task=this.inspect(taskId,viewId)
    if(typeof clue!=='string'||!clue)throw Error('记忆包需要说明线索')
    if(!Array.isArray(items)||items.length>8)throw Error('记忆包条数无效')
    const stored=JSON.stringify({items})
    this.db.prepare(`INSERT INTO yoyo_team_memory_packs(task_id,attempt,clue,scopes,body,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET attempt=excluded.attempt,clue=excluded.clue,scopes=excluded.scopes,body=excluded.body,created_at=excluded.created_at`)
      .run(task.id,task.attempt,boundedText(clue,300,'线索'),JSON.stringify(sourceScopes(view.scopes)),stored,this.clock())
    return {taskId:task.id,clue:clue.slice(0,300),items:items.length}
  }
  memoryPack(taskId,viewId) {
    const view=this.social.view(viewId)
    const row=this.db.prepare('SELECT * FROM yoyo_team_memory_packs WHERE task_id=?').get(taskId)
    if(!row)return null
    if(!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('记忆包不在当前资料范围')
    return {taskId:row.task_id,attempt:row.attempt,clue:row.clue,items:JSON.parse(row.body).items??[],createdAt:row.created_at}
  }
  decideMemory(viewId,{id,decision,reason,claimId=null}) {
    const view=this.social.view(viewId)
    if(!['accept','reject'].includes(decision))throw Error('处理结果无效')
    const row=this.db.prepare('SELECT * FROM yoyo_team_memory_candidates WHERE id=?').get(id)
    if(!row||!JSON.parse(row.scopes).every(scope=>mayRead(view,scope)))throw Error('候选记忆不在当前资料范围')
    if(row.state!=='pending')throw Error('这条候选已经处理过')
    const body={...JSON.parse(row.body)}
    if(decision==='reject'){
      if(reason===undefined||reason===null||reason==='')throw Error('不采纳需要说明理由')
      body.decision=boundedText(reason,500,'理由')
    }else body.decision=null
    const state=decision==='accept'?'accepted':'rejected'
    this.db.prepare('UPDATE yoyo_team_memory_candidates SET state=?,claim_id=?,body=?,decided_at=? WHERE id=?')
      .run(state,decision==='accept'?claimId??null:null,JSON.stringify(body),this.clock(),id)
    return {id,state,claimId:decision==='accept'?claimId??null:null,reason:body.decision??null}
  }
  // A steering note belongs to one task and is consumed once at a native step
  // boundary; a cancelled or finished task cannot receive another.
  steer(viewId,{taskId,message}) {
    const task=this.inspect(taskId,viewId)
    if(!['ready','running','waiting'].includes(task.state))throw Error('只能给进行中的任务追加提示')
    message=boundedText(message,2000,'追加提示')
    const id=Number(this.db.prepare('INSERT INTO yoyo_team_steers(task_id,attempt,body,created_at) VALUES(?,?,?,?)')
      .run(task.id,task.attempt,message,this.clock()).lastInsertRowid)
    return {id,taskId:task.id,state:task.state,delivered:false,message:'追加提示已排队，在执行者下一个原生边界送达。'}
  }
  takeSteers(agentId) {
    const {task}=this.authority(agentId)
    const rows=this.db.prepare('SELECT id,body FROM yoyo_team_steers WHERE task_id=? AND applied_at IS NULL ORDER BY id LIMIT 5').all(task.id)
    for(const row of rows)this.db.prepare('UPDATE yoyo_team_steers SET applied_at=?,agent_id=? WHERE id=? AND applied_at IS NULL').run(this.clock(),agentId,row.id)
    return rows.map(row=>row.body)
  }
  // Per-task counters live in the database, so a restart or a new host does not
  // reset a budget. Attempts are separate rows and never rewritten.
  recordStep(agentId,maxSteps) {
    return this.transaction(()=>{
      const {task}=this.authority(agentId)
      const row=this.db.prepare('SELECT steps,tokens FROM yoyo_team_usage WHERE task_id=? AND attempt=?').get(task.id,task.attempt)
      const steps=(row?.steps??0)+1
      if(Number.isInteger(maxSteps)&&maxSteps>0&&steps>maxSteps)throw Error('任务步骤预算已用尽')
      if(row)this.db.prepare('UPDATE yoyo_team_usage SET steps=steps+1,updated_at=? WHERE task_id=? AND attempt=?').run(this.clock(),task.id,task.attempt)
      else this.db.prepare('INSERT INTO yoyo_team_usage(task_id,attempt,steps,tokens,updated_at) VALUES(?,?,1,0,?)').run(task.id,task.attempt,this.clock())
      return {steps,tokens:row?.tokens??0,maxSteps:maxSteps??null}
    })
  }
  // A runtime that does not report usage must not look like a free run: the
  // count and the fact that it was never reported are stored separately.
  recordTokens(agentId,tokens,reported=true) {
    if(!Number.isSafeInteger(tokens)||tokens<0||tokens>10000000)throw Error('用量记录无效')
    const {task}=this.authority(agentId)
    const flag=reported===true&&tokens>0?1:0
    const row=this.db.prepare('SELECT steps FROM yoyo_team_usage WHERE task_id=? AND attempt=?').get(task.id,task.attempt)
    if(row)this.db.prepare('UPDATE yoyo_team_usage SET tokens=tokens+?,tokens_reported=max(tokens_reported,?),updated_at=? WHERE task_id=? AND attempt=?')
      .run(tokens,flag,this.clock(),task.id,task.attempt)
    else this.db.prepare('INSERT INTO yoyo_team_usage(task_id,attempt,steps,tokens,tokens_reported,updated_at) VALUES(?,?,0,?,?,?)')
      .run(task.id,task.attempt,tokens,flag,this.clock())
    return {tokens,reported:flag===1}
  }
  usage(taskId) {
    const row=this.db.prepare('SELECT coalesce(sum(steps),0) steps,coalesce(sum(tokens),0) tokens,coalesce(max(tokens_reported),0) reported,count(*) attempts FROM yoyo_team_usage WHERE task_id=?').get(taskId)
    const tokens=Number(row?.tokens??0),reported=Number(row?.reported??0)===1
    return {steps:Number(row?.steps??0),tokens,tokensReported:reported,attempts:Number(row?.attempts??0),
      // Zero tokens with no report is unknown usage, never a measured zero.
      note:reported||tokens>0?null:'原生运行时没有上报 Token；0 表示未测量，不代表没有消耗'}
  }
  // A heartbeat extends a live lease within a hard ceiling. It never revives a
  // finished, cancelled or revoked task.
  renew(agentId,ms=900000) {
    const {task}=this.authority(agentId)
    const now=this.clock(),until=now+Math.max(60000,Math.min(Number.isFinite(ms)?ms:900000,3600000))
    this.db.prepare('UPDATE yoyo_team_tasks SET renewed_at=?,expires_at=max(expires_at,?) WHERE id=?').run(now,until,task.id)
    this.db.prepare('UPDATE yoyo_team_speakers SET expires_at=max(expires_at,?) WHERE task_id=?').run(until,task.id)
    return {expiresAt:Math.max(task.expires_at,until)}
  }
  // Failures are counted per task. A retry is only ever scheduled while the
  // configured attempt allowance lasts, and never for a task whose last send
  // is still uncertain.
  noteFailure(taskId,{maxAttempts=0,backoffMs=60000,now=this.clock()}={}) {
    const row=this.db.prepare('SELECT failures,state FROM yoyo_team_tasks WHERE id=?').get(taskId)
    if(!row)throw Error('任务不存在')
    if(!['ready','running','waiting','blocked'].includes(row.state))throw Error('已完成或已取消的任务不需要重试')
    const failures=Number(row.failures??0)+1
    const retryAt=failures<maxAttempts?now+Math.max(0,backoffMs):null
    this.db.prepare("UPDATE yoyo_team_tasks SET state='blocked',failures=?,retry_at=? WHERE id=?").run(failures,retryAt,taskId)
    return {failures,retryAt}
  }
  resumable({now=this.clock(),limit=10}={}) {
    const deliveries=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='yoyo_team_deliveries'").get()
    return this.db.prepare("SELECT id,view_id,failures FROM yoyo_team_tasks WHERE state='blocked' AND retry_at IS NOT NULL AND retry_at<=? ORDER BY retry_at LIMIT ?")
      .all(now,limit)
      .filter(row=>!deliveries||!this.db.prepare("SELECT 1 FROM yoyo_team_deliveries WHERE task_id=? AND state IN ('uncertain','sending')").get(row.id))
  }
  requeue(id) {
    return !!this.db.prepare("UPDATE yoyo_team_tasks SET state='ready',retry_at=NULL WHERE id=? AND state='blocked' AND retry_at IS NOT NULL").run(id).changes
  }
  finish(agentId,state='completed') {
    if(!['completed','cancelled','blocked'].includes(state))throw Error('结束状态无效')
    const {task,view}=this.authority(agentId)
    this.transaction(()=>{
      this.db.prepare('UPDATE yoyo_team_tasks SET state=? WHERE id=?').run(state,task.id)
      this.db.prepare('UPDATE yoyo_team_speakers SET generation=generation+1,expires_at=0 WHERE task_id=?').run(task.id)
    })
    // The end of a branch is an event too, so a sibling can stop waiting for it.
    this.publishEvent({fromTask:task.id,activityId:task.activity_id??null,kind:state==='completed'?'completed':'blocked',body:state==='completed'?'任务已完成':state==='cancelled'?'任务已取消':'任务受阻',viewId:view.id})
  }
}
