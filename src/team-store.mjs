import { randomUUID } from 'node:crypto'
import { boundedText, assertPublish, mayRead } from './scope.mjs'

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
    `)
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {const result=fn();this.db.exec('COMMIT');return result}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  create({key,role,goal,viewId,expiresAt}) {
    if(!['chat','research'].includes(role))throw Error('未知执行角色')
    boundedText(key,300,'幂等键');goal=boundedText(goal,6000,'任务目标')
    const view=this.social.view(viewId)
    if(role==='chat'&&!view.focus)throw Error('聊天任务需要绑定窗口')
    // Until an audited declassification path exists, research starts public.
    if(role==='research'&&view.scopes.some(s=>s!=='public'))throw Error('公开研究必须从公开视图分派')
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock())throw Error('任务期限无效')
    const old=this.db.prepare('SELECT * FROM yoyo_team_tasks WHERE run_key=?').get(key)
    if(old){
      if(old.role!==role||old.goal!==goal||old.view_id!==viewId||old.expires_at!==expiresAt)throw Error('幂等键参数冲突')
      return old
    }
    const id=randomUUID()
    this.db.prepare('INSERT INTO yoyo_team_tasks(id,run_key,role,goal,view_id,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,key,role,goal,viewId,'ready',expiresAt,this.clock())
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
    return this.db.prepare('SELECT id,role,state,expires_at FROM yoyo_team_tasks ORDER BY created_at DESC LIMIT 100').all()
  }
  claim(id,agentId) {
    boundedText(agentId,160,'执行者')
    return this.transaction(()=>{
      const task=this.db.prepare("SELECT * FROM yoyo_team_tasks WHERE id=? AND state='ready'").get(id)
      if(!task||task.expires_at<=this.clock())throw Error('任务不可领取')
      const view=this.social.view(task.view_id)
      if(task.role==='chat'){
        assertPublish(view.scopes,this.social.target(view.focus,{approved:true}).scope)
        const speaker=this.db.prepare('SELECT * FROM yoyo_team_speakers WHERE target=?').get(view.focus)
        if(speaker&&speaker.expires_at>this.clock())throw Error('窗口已有发言者')
        this.speaker(view.focus,agentId,id,task.expires_at,view.id)
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
  finish(agentId,state='completed') {
    if(!['completed','cancelled','blocked'].includes(state))throw Error('结束状态无效')
    return this.transaction(()=>{
      const {task}=this.authority(agentId)
      this.db.prepare('UPDATE yoyo_team_tasks SET state=? WHERE id=?').run(state,task.id)
      this.db.prepare('UPDATE yoyo_team_speakers SET generation=generation+1,expires_at=0 WHERE task_id=?').run(task.id)
    })
  }
}
