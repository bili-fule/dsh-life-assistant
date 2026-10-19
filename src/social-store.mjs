import { randomUUID,createHash } from 'node:crypto'
import { identityPart,targetKey,sourceScopes,mayRead,assertPublish,boundedText,PUBLIC_SCOPE } from './scope.mjs'

// All identity, visibility and delivery authority is host-owned, not message text.
export class SocialStore {
  constructor(store) {
    this.store=store;this.db=store.db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_targets(handle TEXT PRIMARY KEY,platform TEXT NOT NULL,account TEXT NOT NULL,kind TEXT NOT NULL,peer TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',scope TEXT NOT NULL UNIQUE,approved INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_events(id INTEGER PRIMARY KEY,external_key TEXT NOT NULL UNIQUE,target TEXT NOT NULL REFERENCES yoyo_targets(handle),sender TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,segments TEXT NOT NULL DEFAULT '[]',received_at INTEGER NOT NULL,mentioned INTEGER NOT NULL DEFAULT 0,read_at INTEGER,source_inbox INTEGER UNIQUE);
      CREATE INDEX IF NOT EXISTS yoyo_events_target ON yoyo_events(target,id);
      CREATE TABLE IF NOT EXISTS yoyo_views(id TEXT PRIMARY KEY,focus TEXT,scopes TEXT NOT NULL,authorization_version INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_activity(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'idle',body TEXT NOT NULL DEFAULT '{}',scopes TEXT NOT NULL DEFAULT '["public"]',wake_at INTEGER,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_turns(request_id TEXT PRIMARY KEY,view_id TEXT NOT NULL REFERENCES yoyo_views(id),state TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS yoyo_event_scopes(session_id TEXT NOT NULL,seq INTEGER NOT NULL,scopes TEXT NOT NULL,PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS yoyo_memories(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,sources TEXT NOT NULL,confidence TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS yoyo_retirements(memory_id INTEGER PRIMARY KEY,through_id INTEGER NOT NULL,forgotten_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_outbox(id INTEGER PRIMARY KEY,run_key TEXT NOT NULL UNIQUE,target TEXT NOT NULL REFERENCES yoyo_targets(handle),authorization_version INTEGER NOT NULL,view_id TEXT NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,remote_id TEXT,error TEXT,sent_at INTEGER);
      CREATE TABLE IF NOT EXISTS yoyo_usage(day TEXT PRIMARY KEY,steps INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS yoyo_jobs(id TEXT PRIMARY KEY,run_key TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_documents(id INTEGER PRIMARY KEY,url TEXT NOT NULL,body TEXT NOT NULL,scope TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_assets(id TEXT PRIMARY KEY,path TEXT NOT NULL,scopes TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(path,scopes));
      CREATE TABLE IF NOT EXISTS yoyo_plans(id INTEGER PRIMARY KEY,title TEXT NOT NULL,progress TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'open',scopes TEXT NOT NULL,view_id TEXT NOT NULL,not_before INTEGER,updated_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO yoyo_activity(id,updated_at) VALUES(1,0);
    `)
    // A lost response can mean an actual sent message. Never blindly resend it.
    this.db.prepare("UPDATE yoyo_outbox SET state='uncertain',error='进程重启前未取得确定回执' WHERE state='sending'").run()
  }
  target(handle,{approved=false}={}) {
    const row=this.db.prepare('SELECT * FROM yoyo_targets WHERE handle=?').get(handle)
    if(!row||approved&&!row.approved)throw Error('聊天窗口不存在或未获授权')
    return row
  }
  discover({platform,account,kind,peer,label=''}) {
    const handle=targetKey(platform,account,kind,peer),scope=handle
    this.db.prepare('INSERT OR IGNORE INTO yoyo_targets(handle,platform,account,kind,peer,label,scope,created_at) VALUES(?,?,?,?,?,?,?,?)').run(handle,platform,String(account),kind,String(peer),String(label).slice(0,160),scope,Date.now())
    return this.target(handle)
  }
  approve(handle,approved) {
    if(typeof approved!=='boolean')throw Error('授权状态无效')
    this.target(handle)
    this.db.prepare('UPDATE yoyo_targets SET approved=?,version=version+1 WHERE handle=?').run(approved?1:0,handle)
    this.db.prepare("UPDATE yoyo_outbox SET state='cancelled',error='目标授权已改变' WHERE target=? AND state IN ('queued','retry_wait')").run(handle)
    this.store.audit('yoyo.authorization',{target:handle,approved})
    return this.target(handle)
  }
  ingest({target,sender,externalId,text='',segments=[],kind='message',mentioned=false,receivedAt=Date.now(),sourceInbox=null}) {
    const t=this.target(target);identityPart(sender);identityPart(externalId,'原消息编号')
    if(typeof text!=='string'||text.length>100000||!Array.isArray(segments)||segments.length>1000||!Number.isSafeInteger(receivedAt))throw Error('消息格式无效')
    const key=JSON.stringify([t.platform,t.account,t.handle,String(externalId)])
    const result=this.db.prepare('INSERT OR IGNORE INTO yoyo_events(external_key,target,sender,scope,kind,text,segments,received_at,mentioned,source_inbox) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,t.handle,String(sender),t.scope,kind,text,JSON.stringify(segments),receivedAt,mentioned?1:0,sourceInbox)
    return {inserted:!!result.changes,id:result.changes?Number(result.lastInsertRowid):this.db.prepare('SELECT id FROM yoyo_events WHERE external_key=?').get(key).id}
  }
  inbox() {
    return this.db.prepare(`SELECT t.handle,t.platform,t.kind,t.label,count(e.id) unread,max(e.mentioned) mentioned,min(e.received_at) oldest,max(e.id) latest FROM yoyo_targets t LEFT JOIN yoyo_events e ON e.target=t.handle AND e.read_at IS NULL WHERE t.approved=1 GROUP BY t.handle ORDER BY mentioned DESC,oldest LIMIT 100`).all()
  }
  open(handle) {
    const t=this.target(handle,{approved:true})
    const view={id:randomUUID(),focus:t.handle,scopes:[PUBLIC_SCOPE,t.scope],authorizationVersion:t.version,createdAt:Date.now()}
    this.db.prepare('INSERT INTO yoyo_views VALUES(?,?,?,?,?)').run(view.id,view.focus,JSON.stringify(view.scopes),view.authorizationVersion,view.createdAt)
    return view
  }
  publicView() {
    const view={id:randomUUID(),focus:null,scopes:[PUBLIC_SCOPE],authorizationVersion:null,createdAt:Date.now()}
    this.db.prepare('INSERT INTO yoyo_views VALUES(?,?,?,?,?)').run(view.id,null,JSON.stringify(view.scopes),null,view.createdAt)
    return view
  }
  planningView() {
    const scopes=[PUBLIC_SCOPE,...this.db.prepare('SELECT scope FROM yoyo_targets WHERE approved=1 ORDER BY handle').all().map(t=>t.scope)]
    const view={id:randomUUID(),focus:null,scopes,authorizationVersion:null,createdAt:Date.now()}
    this.db.prepare('INSERT INTO yoyo_views VALUES(?,?,?,?,?)').run(view.id,null,JSON.stringify(view.scopes),null,view.createdAt)
    return view
  }
  view(id) {
    const row=this.db.prepare('SELECT * FROM yoyo_views WHERE id=?').get(id)
    if(!row)throw Error('资料视图不存在')
    if(row.focus){const t=this.target(row.focus,{approved:true});if(t.version!==row.authorization_version)throw Error('资料视图授权已失效')}
    const scopes=JSON.parse(row.scopes)
    for(const scope of scopes)if(scope!==PUBLIC_SCOPE&&!this.db.prepare('SELECT 1 FROM yoyo_targets WHERE scope=? AND approved=1').get(scope))throw Error('资料视图授权已失效')
    return {id:row.id,focus:row.focus,scopes,authorizationVersion:row.authorization_version,createdAt:row.created_at}
  }
  read(viewId,{after,limit=30,query=''}={}) {
    const view=this.view(viewId)
    if(!view.focus)throw Error('请先选择要阅读的聊天窗口')
    if(after!==undefined&&(!Number.isInteger(after)||after<0)||!Number.isInteger(limit)||limit<1||limit>50||typeof query!=='string'||query.length>300)throw Error('读取范围无效')
    if(after===undefined){const first=this.db.prepare('SELECT min(id) n FROM yoyo_events WHERE target=? AND read_at IS NULL').get(view.focus).n;after=first?Math.max(0,first-4):Math.max(0,(this.db.prepare('SELECT max(id) n FROM yoyo_events WHERE target=?').get(view.focus).n??0)-limit)}
    return this.db.prepare('SELECT id,sender,kind,text,segments,received_at,mentioned,source_inbox FROM yoyo_events WHERE target=? AND id>? AND instr(lower(text),lower(?))>0 ORDER BY id LIMIT ?').all(view.focus,after,query,limit).map(r=>({...r,segments:JSON.parse(r.segments)}))
  }
  markRead(viewId,ids) {
    const v=this.view(viewId);if(!Array.isArray(ids)||ids.length>50||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('原文编号无效')
    this.store.transaction(()=>{for(const id of ids){
      this.db.prepare('UPDATE yoyo_events SET read_at=? WHERE target=? AND id=? AND read_at IS NULL').run(Date.now(),v.focus,id)
      this.db.prepare("UPDATE inbox SET state='done',result=coalesce(result,?) WHERE id IN (SELECT source_inbox FROM yoyo_events WHERE target=? AND id=?) AND state='pending'").run(JSON.stringify({mode:'autonomous',decision:'read'}),v.focus,id)
    }})
  }
  activity(viewId=null) {
    const r=this.db.prepare('SELECT * FROM yoyo_activity WHERE id=1').get(),scopes=JSON.parse(r.scopes)
    if(viewId&&!scopes.every(s=>mayRead(this.view(viewId),s)))return {revision:r.revision,state:r.state,body:{},wake_at:r.wake_at,restricted:true}
    return {...r,body:JSON.parse(r.body),scopes}
  }
  saveActivity(viewId,{state='idle',description='',next='',wakeAt=null}={}) {
    const view=this.view(viewId)
    if(!['idle','working','sleeping','waiting','paused'].includes(state)||typeof description!=='string'||description.length>1000||typeof next!=='string'||next.length>1000||wakeAt!==null&&(!Number.isSafeInteger(wakeAt)||wakeAt<Date.now()||wakeAt>Date.now()+30*86400000))throw Error('活动或唤醒时间无效')
    this.db.prepare('UPDATE yoyo_activity SET revision=revision+1,state=?,body=?,scopes=?,wake_at=?,updated_at=? WHERE id=1').run(state,JSON.stringify({description,next}),JSON.stringify(view.scopes),wakeAt,Date.now())
    return this.activity(viewId)
  }
  remember(viewId,{kind='episodes',body,sources=[],confidence='observed',expiresAt=null}) {
    const view=this.view(viewId);body=boundedText(body,2000)
    if(!['episodes','profile','relations','knowledge','procedures','intention','communication'].includes(kind)||!['observed','hypothesis','self_report'].includes(confidence)||!Array.isArray(sources)||!sources.length||sources.length>10||expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()))throw Error('记忆类型或来源无效')
    for(const s of sources){
      if(!s||typeof s!=='object'||!Number.isSafeInteger(s.document??s.id)||s.document!==undefined&&s.id!==undefined)throw Error('原文来源编号无效')
      const row=s.document!==undefined?this.db.prepare('SELECT body text,scope FROM yoyo_documents WHERE id=?').get(s.document):this.db.prepare('SELECT text,scope FROM yoyo_events WHERE id=?').get(s.id)
      if(!row||!mayRead(view,row.scope)||typeof s.quote!=='string'||!s.quote.trim()||!row.text.includes(s.quote))throw Error('记忆必须有当前可见原文的逐字证据')
    }
    const forgotten=this.db.prepare('SELECT r.through_id FROM yoyo_memories m JOIN yoyo_retirements r ON r.memory_id=m.id WHERE m.body=?').all(body)
    if(forgotten.some(r=>sources.every(s=>s.document!==undefined||s.id<=r.through_id)))throw Error('不能从旧原文重新学习已忘记的内容')
    const scopes=sourceScopes(view.scopes)
    const duplicate=this.db.prepare('SELECT id FROM yoyo_memories WHERE body=? AND scopes=? AND active=1').get(body,JSON.stringify(scopes))
    if(duplicate)return {id:duplicate.id,duplicate:true}
    const id=Number(this.db.prepare('INSERT INTO yoyo_memories(kind,body,scopes,sources,confidence,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(kind,body,JSON.stringify(scopes),JSON.stringify(sources),confidence,Date.now(),expiresAt??(kind==='episodes'?Date.now()+48*3600000:null)).lastInsertRowid)
    return {id}
  }
  recall(viewId,{query='',limit=20}={}) {
    const view=this.view(viewId);if(typeof query!=='string'||query.length>300||!Number.isInteger(limit)||limit<1||limit>30)throw Error('检索参数无效')
    // SQL restricts visibility before text is returned, not after a model has seen it.
    return this.db.prepare(`SELECT m.* FROM yoyo_memories m WHERE active=1 AND (expires_at IS NULL OR expires_at>?) AND instr(lower(body),lower(?))>0 AND NOT EXISTS (SELECT 1 FROM json_each(m.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?))) ORDER BY id DESC LIMIT ?`).all(Date.now(),query,JSON.stringify(view.scopes),limit).map(r=>({...r,scopes:JSON.parse(r.scopes),sources:JSON.parse(r.sources)}))
  }
  forget(id) {
    if(!Number.isSafeInteger(id))throw Error('记忆编号无效')
    return this.store.transaction(()=>{const changed=this.db.prepare('UPDATE yoyo_memories SET active=0 WHERE id=? AND active=1').run(id).changes;if(changed)this.db.prepare('INSERT OR REPLACE INTO yoyo_retirements VALUES(?,?,?)').run(id,this.db.prepare('SELECT coalesce(max(id),0) n FROM yoyo_events').get().n,Date.now());return changed})
  }
  plans(viewId) {
    const view=this.view(viewId)
    return this.db.prepare(`SELECT id,title,progress,state,not_before,updated_at FROM yoyo_plans p WHERE NOT EXISTS (SELECT 1 FROM json_each(p.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?))) ORDER BY state='open' DESC,updated_at DESC LIMIT 30`).all(JSON.stringify(view.scopes))
  }
  plan(viewId,{id,title,progress='',state='open',notBefore=null}) {
    const view=this.view(viewId)
    if(!['open','waiting','done','cancelled'].includes(state)||typeof progress!=='string'||progress.length>2000||notBefore!==null&&(!Number.isSafeInteger(notBefore)||notBefore<0))throw Error('打算状态无效')
    if(id!==undefined){
      if(!Number.isSafeInteger(id)||!this.plans(viewId).some(p=>p.id===id))throw Error('打算不存在或不在当前资料范围')
      if(title!==undefined)boundedText(title,300)
      this.db.prepare('UPDATE yoyo_plans SET title=coalesce(?,title),progress=?,state=?,not_before=?,updated_at=? WHERE id=?').run(title??null,progress,state,notBefore,Date.now(),id)
    }else{
      title=boundedText(title,300)
      id=Number(this.db.prepare('INSERT INTO yoyo_plans(title,progress,state,scopes,view_id,not_before,updated_at) VALUES(?,?,?,?,?,?,?)').run(title,progress,state,JSON.stringify(view.scopes),view.id,notBefore,Date.now()).lastInsertRowid)
    }
    return {id,state}
  }
  labelEvent(sessionId,seq,scopes) {
    if(!Number.isSafeInteger(seq)||seq<0)throw Error('原生事件编号无效')
    this.db.prepare('INSERT OR IGNORE INTO yoyo_event_scopes VALUES(?,?,?)').run(sessionId,seq,JSON.stringify(sourceScopes(scopes)))
  }
  eventVisible(sessionId,seq,viewId) {
    const row=this.db.prepare('SELECT scopes FROM yoyo_event_scopes WHERE session_id=? AND seq=?').get(sessionId,seq)
    return !!row&&JSON.parse(row.scopes).every(s=>mayRead(this.view(viewId),s))
  }
  enqueue(viewId,target,text,runKey,now=Date.now()) {
    const view=this.view(viewId),t=this.target(target,{approved:true});text=boundedText(text)
    if(!['wechat','qq'].includes(t.platform))throw Error('此窗口不支持平台发信')
    assertPublish(view.scopes,t.scope)
    if(view.focus!==target||view.authorizationVersion!==t.version)throw Error('发件目标与当前资料视图不一致')
    if(typeof runKey!=='string'||!runKey)throw Error('发送缺少原生动作回执编号')
    this.db.prepare('INSERT OR IGNORE INTO yoyo_outbox(run_key,target,authorization_version,view_id,body,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(runKey,target,t.version,viewId,text,JSON.stringify(view.scopes),now,now+(t.kind==='group'?300000:3600000))
    const row=this.db.prepare('SELECT id,state,body,target FROM yoyo_outbox WHERE run_key=?').get(runKey)
    if(row.body!==text||row.target!==target)throw Error('同一原生调用不能更换收件人或正文')
    return {id:row.id,state:row.state,queued:row.state==='queued',delivered:row.state==='sent'}
  }
  async deliver(send,now=Date.now(),{ownerOnly=false}={}) {
    const row=this.db.prepare("SELECT * FROM yoyo_outbox WHERE state IN ('queued','retry_wait') AND next_at<=? AND (?=0 OR target IN (SELECT handle FROM yoyo_targets WHERE platform='wechat' AND kind='owner')) ORDER BY id LIMIT 1").get(now,ownerOnly?1:0)
    if(!row)return false
    const authorize=()=>{try{const t=this.target(row.target,{approved:true});if(t.version!==row.authorization_version||row.expires_at<Math.max(now,Date.now()))throw Error('授权已变化或回复已过期');this.view(row.view_id);assertPublish(JSON.parse(row.scopes),t.scope)}catch(e){e.authorityInvalid=true;throw e}}
    try{authorize()}
    catch(e){this.db.prepare("UPDATE yoyo_outbox SET state='cancelled',error=? WHERE id=?").run(e.message,row.id);return false}
    this.db.prepare("UPDATE yoyo_outbox SET state='sending',attempts=attempts+1 WHERE id=?").run(row.id)
    try{
      const result=await send(this.target(row.target),row.body,'yoyo-'+createHash('sha256').update(row.run_key).digest('hex').slice(0,24),authorize)
      if(!result?.messageId)throw Error('发送接口未提供确定回执')
      this.store.transaction(()=>{
        this.db.prepare("UPDATE yoyo_outbox SET state='sent',remote_id=?,sent_at=?,error=NULL WHERE id=?").run(String(result.messageId),now,row.id)
        const target=this.target(row.target),event=this.ingest({target:row.target,sender:target.account,externalId:'sent:'+result.messageId,text:row.body,kind:'outgoing',receivedAt:now})
        this.db.prepare('UPDATE yoyo_events SET read_at=? WHERE id=?').run(now,event.id)
      });return true
    }catch(e){
      const state=e.authorityInvalid?'cancelled':e.definitelyNotSent?'retry_wait':'uncertain'
      this.db.prepare('UPDATE yoyo_outbox SET state=?,next_at=?,error=? WHERE id=?').run(state,now+Math.min(3600000,30000*2**Math.min(row.attempts,6)),String(e.message).slice(0,300),row.id);return false
    }
  }
  snapshot() {return {activity:this.activity(),targets:this.db.prepare('SELECT handle,platform,account,kind,peer,label,approved,version FROM yoyo_targets ORDER BY created_at').all(),inbox:this.inbox(),outbox:this.db.prepare('SELECT id,target,state,attempts,error,sent_at FROM yoyo_outbox ORDER BY id DESC LIMIT 30').all()}}
}
