import { randomUUID,createHash } from 'node:crypto'
import { boundedText } from './scope.mjs'

// One authority for "work that should happen": an activity is the continuing goal,
// an intent is one delegable piece of that goal, and a task is one attempt at an
// intent. The queue lives here so the subject does not grow a second to-do list,
// and so a branch cannot create work that the subject never asked for.
export const INTENT_STATES=['ready','claimed','running','waiting','blocked','completed','abandoned']
export const TERMINAL_INTENT_STATES=['completed','abandoned']
// Capabilities are the subject's words; the host maps them to the fixed role
// surface. An unknown capability is refused instead of silently becoming a peer.
export const CAPABILITY_ROLES={chat:'chat',read:'reader',web:'research',research:'research',verify:'verify',code:'engineer',engineer:'engineer',peer:'peer'}
const AGING_STEP_MS=300000,AGING_CAP=20

export class TeamIntents {
  constructor(social,clock=Date.now,metrics=null){
    this.social=social;this.db=social.db;this.clock=clock;this.metrics=metrics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_intents(
        id TEXT PRIMARY KEY, view_id TEXT NOT NULL, activity_id TEXT, concern_id INTEGER,
        goal TEXT NOT NULL, why TEXT NOT NULL, capabilities TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER, depends_on TEXT, done_when TEXT NOT NULL DEFAULT '', stop_when TEXT NOT NULL DEFAULT '',
        target TEXT, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, dedupe_key TEXT NOT NULL UNIQUE,
        task_id TEXT, claimed_by TEXT, lease_expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_intent_attempts(
        id INTEGER PRIMARY KEY, intent_id TEXT NOT NULL, task_id TEXT NOT NULL, state TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    `)
  }
  roleFor(intent){
    const capabilities=typeof intent.capabilities==='string'?JSON.parse(intent.capabilities):intent.capabilities??[]
    for(const capability of capabilities)if(!CAPABILITY_ROLES[capability])throw Error('未知的能力：'+capability)
    const set=new Set(capabilities)
    if(!set.size)throw Error('意图需要至少一项能力')
    // The narrowest role that can actually do the work. Reading a private window
    // and browsing public pages at the same time needs a peer: a reader cannot
    // reach the web, and research cannot see the window. Guessing a role here
    // would hand the branch a different task than the subject asked for.
    if(set.has('code')||set.has('engineer'))return 'engineer'
    if(set.has('chat')&&set.has('web'))return 'peer'
    if(set.has('read')&&set.has('web'))return 'peer'
    if(set.has('chat'))return 'chat'
    if(set.has('read'))return 'reader'
    if(set.has('verify'))return 'verify'
    if(set.has('web')||set.has('research'))return 'research'
    return 'peer'
  }
  effectivePriority(row,now=this.clock()){
    const waited=Math.max(0,now-(row.not_before??row.created_at))
    // Waiting must never starve: a low priority item rises one point every five
    // minutes it is ready, capped so it cannot drown an urgent commitment.
    return row.priority+Math.min(AGING_CAP,Math.floor(waited/AGING_STEP_MS))
  }
  create({activityId=null,concernId=null,goal,why,capabilities,priority=0,notBefore=null,dependsOn=[],doneWhen='',stopWhen='',target=null,viewId,dedupe=null,now=this.clock()}){
    goal=boundedText(goal,6000,'意图目标');why=boundedText(why,2000,'意图理由')
    if(!Array.isArray(capabilities)||!capabilities.length||capabilities.length>4)throw Error('意图需要一至四项能力')
    for(const capability of capabilities)if(!CAPABILITY_ROLES[capability])throw Error('未知的能力：'+capability)
    if(!Number.isInteger(priority)||priority<0||priority>100)throw Error('优先级需要 0–100')
    if(notBefore!==null&&(!Number.isSafeInteger(notBefore)||notBefore<=0))throw Error('等待时间无效')
    if(!Array.isArray(dependsOn)||dependsOn.length>4)throw Error('依赖意图无效')
    for(const id of dependsOn)if(!this.db.prepare('SELECT 1 FROM yoyo_intents WHERE id=?').get(String(id)))throw Error('依赖的意图不存在')
    const view=this.social.view(viewId)
    if(activityId!==null&&!this.social.activities(viewId).some(activity=>activity.activityId===activityId))throw Error('活动不存在或不在当前资料范围')
    const base='intent-'+createHash('sha256').update(JSON.stringify([view.focus??'',activityId,capabilities.slice().sort(),goal])).digest('hex').slice(0,32)
    const previous=this.db.prepare('SELECT * FROM yoyo_intents WHERE dedupe_key LIKE ? ORDER BY revision DESC LIMIT 1').get(base+'%')
    // The same purpose in the same activity is one intent, not two branches doing
    // identical work. A finished one may be attempted again as a new revision.
    if(previous&&!TERMINAL_INTENT_STATES.includes(previous.state))return {...this.shape(previous),reused:true}
    const revision=previous?previous.revision+1:1
    const id=randomUUID()
    this.db.prepare(`INSERT INTO yoyo_intents(id,view_id,activity_id,concern_id,goal,why,capabilities,priority,not_before,depends_on,done_when,stop_when,target,state,revision,dedupe_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,viewId,activityId,concernId,goal,why,JSON.stringify([...new Set(capabilities)]),priority,notBefore,JSON.stringify([...new Set(dependsOn)]),doneWhen,stopWhen,target,'ready',revision,base+(revision>1?':'+revision:''),now,now)
    if(activityId)this.social.linkActivity(activityId,'intent',id)
    this.metrics?.count('intent_created')
    return this.shape(this.db.prepare('SELECT * FROM yoyo_intents WHERE id=?').get(id))
  }
  shape(row){
    if(!row)return null
    return {...row,capabilities:JSON.parse(row.capabilities),dependsOn:JSON.parse(row.depends_on??'[]'),aging:this.effectivePriority(row)}
  }
  get(id){return this.shape(this.db.prepare('SELECT * FROM yoyo_intents WHERE id=?').get(String(id)))}
  list({state=null,activityId=null,limit=30,now=this.clock()}={}){
    const rows=[]
    for(const row of this.db.prepare('SELECT * FROM yoyo_intents ORDER BY created_at DESC LIMIT ?').all(Math.min(100,Math.max(1,limit)))){
      if(state&&row.state!==state)continue
      if(activityId&&row.activity_id!==activityId)continue
      try{this.social.view(row.view_id)}catch{continue}
      rows.push(this.shape(row))
    }
    return rows
  }
  // Which ready intent may start now: dependencies really finished, its own time
  // has come, and the ordering is priority plus the time it has already waited.
  ready({now=this.clock(),limit=10}={}){
    const candidates=[]
    for(const row of this.db.prepare("SELECT * FROM yoyo_intents WHERE state='ready' ORDER BY created_at LIMIT 100").all()){
      if(row.not_before!==null&&row.not_before>now)continue
      const depends=JSON.parse(row.depends_on??'[]')
      const unmet=depends.filter(id=>this.db.prepare('SELECT state FROM yoyo_intents WHERE id=?').get(id)?.state!=='completed')
      if(unmet.length)continue
      try{this.social.view(row.view_id)}catch{continue}
      candidates.push(this.shape(row))
    }
    return candidates.sort((a,b)=>b.aging-a.aging||a.created_at-b.created_at).slice(0,limit)
  }
  claim(id,{agentId,taskId,now=this.clock(),leaseMs=900000}={}){
    const row=this.db.prepare("SELECT * FROM yoyo_intents WHERE id=? AND state='ready'").get(String(id))
    if(!row)throw Error('意图不可领取')
    this.db.prepare("UPDATE yoyo_intents SET state='running',claimed_by=?,task_id=?,lease_expires=?,attempts=attempts+1,updated_at=? WHERE id=?")
      .run(agentId??null,taskId??null,now+leaseMs,now,row.id)
    this.db.prepare('INSERT INTO yoyo_intent_attempts(intent_id,task_id,state,note,created_at) VALUES(?,?,?,?,?)').run(row.id,taskId??'','running','开始执行',now)
    this.metrics?.count('intent_claimed')
    return this.get(row.id)
  }
  // Attempt state is a real record: waiting is not running, and a cancelled
  // attempt is abandoned work rather than a quiet success.
  note(id,state,note='',now=this.clock()){
    if(!INTENT_STATES.includes(state))throw Error('意图状态无效')
    const row=this.get(id)
    if(!row)throw Error('意图不存在')
    this.db.prepare('UPDATE yoyo_intents SET state=?,updated_at=? WHERE id=?').run(state,now,id)
    if(row.task_id)this.db.prepare('INSERT INTO yoyo_intent_attempts(intent_id,task_id,state,note,created_at) VALUES(?,?,?,?,?)').run(id,row.task_id,state,note,now)
    return this.get(id)
  }
  cancel(id,reason='',now=this.clock()){
    const row=this.get(id)
    if(!row)throw Error('意图不存在')
    if(TERMINAL_INTENT_STATES.includes(row.state))return row
    this.db.prepare('UPDATE yoyo_intents SET state=?,cancel_reason=?,updated_at=? WHERE id=?').run('abandoned',boundedText(String(reason??''),1000,'放弃理由'),now,id)
    return this.get(id)
  }
  // Priority and start time stay adjustable while the work is still queued: the
  // subject may reorder its own queue without editing a branch that is already
  // working, and a running intent cannot be silently re-pointed.
  adjust(id,{priority,notBefore}={},now=this.clock()){
    const row=this.get(id)
    if(!row)throw Error('意图不存在')
    if(TERMINAL_INTENT_STATES.includes(row.state))throw Error('意图已经结束，不能再调整')
    if(priority!==undefined&&(!Number.isInteger(priority)||priority<0||priority>100))throw Error('优先级需要 0–100')
    if(notBefore!==undefined&&notBefore!==null&&(!Number.isSafeInteger(notBefore)||notBefore<=0))throw Error('等待时间无效')
    if(row.state!=='ready'&&(priority!==undefined||notBefore!==undefined))throw Error('只有排队中的意图能调整优先级或开始时间')
    this.db.prepare('UPDATE yoyo_intents SET priority=coalesce(?,priority),not_before=?,updated_at=? WHERE id=?')
      .run(priority??null,notBefore===undefined?row.not_before:notBefore,now,id)
    return this.get(id)
  }
  // Task state is mirrored onto its intent instead of being a second truth: the
  // task remains the authority for one attempt, the intent for the piece of work.
  syncFromTasks(now=this.clock()){
    const mapped={completed:'completed',cancelled:'abandoned',blocked:'blocked',suspended:'waiting',running:'running',waiting:'waiting'}
    for(const row of this.db.prepare("SELECT i.id,i.state,t.state task_state FROM yoyo_intents i JOIN yoyo_team_tasks t ON t.id=i.task_id WHERE i.state NOT IN ('completed','abandoned')").all()){
      const state=mapped[row.task_state]
      if(!state||state===row.state)continue
      this.db.prepare('UPDATE yoyo_intents SET state=?,updated_at=? WHERE id=?').run(state,now,row.id)
      this.db.prepare('INSERT INTO yoyo_intent_attempts(intent_id,task_id,state,note,created_at) VALUES(?,?,?,?,?)')
        .run(row.id,this.db.prepare('SELECT task_id FROM yoyo_intents WHERE id=?').get(row.id).task_id,state,'跟随任务状态',now)
    }
  }
  // What the subject and the console may see: state, wait reason and age, never
  // the branch's own text.
  summary({activityId=null,limit=20,now=this.clock()}={}){
    const rows=this.list({activityId,limit,now})
    return rows.map(row=>({id:row.id,state:row.state,capabilities:row.capabilities,priority:row.priority,aging:row.aging,
      dependsOn:row.dependsOn.length,attempts:row.attempts,taskId:row.task_id,notBefore:row.not_before,
      waitReason:row.state!=='ready'?row.state:(row.dependsOn.length?'等待依赖':row.not_before&&row.not_before>now?'等待时间':'等待调度'),
      waitedMs:Math.max(0,now-row.created_at)}))
  }
}
