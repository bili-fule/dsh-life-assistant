import { randomUUID } from 'node:crypto'
import { boundedText, assertPublish, mayRead, sourceScopes } from './scope.mjs'

// Each role is a fixed set of host methods. A task may narrow its role, never
// widen it; the model cannot name a tool outside its role.
export const ROLE_TOOLS={
  chat:['read','wait','recall','send','report','evidence','board','usage','step'],
  research:['web','report','evidence','board','usage','step'],
  reader:['read','recall','report','evidence','board','usage','step'],
  verify:['board','recall','report','evidence','usage','step'],
}

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
        tokens INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(task_id,attempt));
    `)
    const columns=this.db.prepare('PRAGMA table_info(yoyo_team_tasks)').all().map(column=>column.name)
    for(const [name,type] of [['failures','INTEGER NOT NULL DEFAULT 0'],['retry_at','INTEGER'],['renewed_at','INTEGER'],
      ['parent_id','TEXT'],['depends_on','TEXT'],['toolset','TEXT'],['authorization_version','INTEGER'],
      ['persona_version','INTEGER'],['max_steps','INTEGER']])
      if(!columns.includes(name))this.db.exec(`ALTER TABLE yoyo_team_tasks ADD COLUMN ${name} ${type}`)
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {const result=fn();this.db.exec('COMMIT');return result}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  create({key,role,goal,viewId,expiresAt,parentId=null,dependsOn=null,toolset=null,maxSteps=null}) {
    if(!Object.keys(ROLE_TOOLS).includes(role))throw Error('未知执行角色')
    boundedText(key,300,'幂等键');goal=boundedText(goal,6000,'任务目标')
    const view=this.social.view(viewId)
    // chat and reader work inside one window; research and verify never imply a
    // private window.
    if(['chat','reader'].includes(role)&&!view.focus)throw Error('该角色需要绑定窗口')
    // Until an audited declassification path exists, public work starts public.
    if(role==='research'&&view.scopes.some(s=>s!=='public'))throw Error('公开研究必须从公开视图分派')
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock())throw Error('任务期限无效')
    let tools=null
    if(toolset!==null){
      if(!Array.isArray(toolset)||!toolset.length||toolset.length>9||toolset.some(name=>!ROLE_TOOLS[role].includes(name)))throw Error('工具集必须属于该角色')
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
    const old=this.db.prepare('SELECT * FROM yoyo_team_tasks WHERE run_key=?').get(key)
    if(old){
      if(old.role!==role||old.goal!==goal||old.view_id!==viewId||old.expires_at!==expiresAt)throw Error('幂等键参数冲突')
      return old
    }
    // Snapshots make a stale authorisation or persona visible instead of implicit.
    const authorization=view.focus&&['chat','reader'].includes(role)?this.social.target(view.focus,{approved:true}).version:null
    const persona=this.db.prepare('SELECT coalesce(max(id),0) id FROM yoyo_persona_versions').get().id
    const id=randomUUID()
    this.db.prepare('INSERT INTO yoyo_team_tasks(id,run_key,role,goal,view_id,state,expires_at,created_at,parent_id,depends_on,toolset,authorization_version,persona_version,max_steps) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,key,role,goal,viewId,'ready',expiresAt,this.clock(),parentId,depends,tools,authorization,persona,maxSteps)
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
      if(['chat','reader'].includes(task.role)){
        const target=this.social.target(view.focus,{approved:true})
        // The task carries the authorisation it was created under; a newer
        // version means the window changed and the old task must not continue.
        if(task.authorization_version!==null&&target.version!==task.authorization_version)throw Error('目标授权已变化，不能沿用旧任务')
        if(task.role==='chat'){
          assertPublish(view.scopes,target.scope)
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
  takeover(viewId,mainAgentId,expiresAt) {
    const view=this.social.view(viewId)
    if(!view.focus||!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock())throw Error('接管参数无效')
    assertPublish(view.scopes,this.social.target(view.focus,{approved:true}).scope)
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT task_id FROM yoyo_team_speakers WHERE target=?').get(view.focus)
      if(previous?.task_id)this.db.prepare("UPDATE yoyo_team_tasks SET state='cancelled' WHERE id=?").run(previous.task_id)
      return this.speaker(view.focus,mainAgentId,null,expiresAt,view.id)
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
      assertPublish(view.scopes,this.social.target(target,{approved:true}).scope)
    }
    return true
  }
  report(agentId,body) {
    const {task}=this.authority(agentId)
    body=boundedText(body,12000,'进展')
    this.db.prepare('INSERT INTO yoyo_team_reports(task_id,attempt,body,created_at) VALUES(?,?,?,?)').run(task.id,task.attempt,body,this.clock())
  }
  reports(id,viewId) {
    this.inspect(id,viewId)
    return this.db.prepare('SELECT id,body,created_at FROM yoyo_team_reports WHERE task_id=? ORDER BY id DESC LIMIT 50').all(id)
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
  recordTokens(agentId,tokens) {
    if(!Number.isSafeInteger(tokens)||tokens<0||tokens>10000000)throw Error('用量记录无效')
    const {task}=this.authority(agentId)
    const row=this.db.prepare('SELECT steps FROM yoyo_team_usage WHERE task_id=? AND attempt=?').get(task.id,task.attempt)
    if(row)this.db.prepare('UPDATE yoyo_team_usage SET tokens=tokens+?,updated_at=? WHERE task_id=? AND attempt=?').run(tokens,this.clock(),task.id,task.attempt)
    else this.db.prepare('INSERT INTO yoyo_team_usage(task_id,attempt,steps,tokens,updated_at) VALUES(?,?,0,?,?)').run(task.id,task.attempt,tokens,this.clock())
    return {tokens}
  }
  usage(taskId) {
    const row=this.db.prepare('SELECT coalesce(sum(steps),0) steps,coalesce(sum(tokens),0) tokens,count(*) attempts FROM yoyo_team_usage WHERE task_id=?').get(taskId)
    return {steps:Number(row?.steps??0),tokens:Number(row?.tokens??0),attempts:Number(row?.attempts??0)}
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
    return this.transaction(()=>{
      const {task}=this.authority(agentId)
      this.db.prepare('UPDATE yoyo_team_tasks SET state=? WHERE id=?').run(state,task.id)
      this.db.prepare('UPDATE yoyo_team_speakers SET generation=generation+1,expires_at=0 WHERE task_id=?').run(task.id)
    })
  }
}
