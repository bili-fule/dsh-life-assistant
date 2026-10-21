import { randomUUID,createHash } from 'node:crypto'
import { identityPart,targetKey,sourceScopes,mayRead,assertPublish,boundedText,PUBLIC_SCOPE } from './scope.mjs'

const NARRATIVE_TOOLS=new Set(['yoyo_memory','yoyo_forget','yoyo_recall','yoyo_evidence','yoyo_activity','yoyo_plan','yoyo_self','yoyo_concern','yoyo_feedback','yoyo_learning','yoyo_sleep','yoyo_wait','self_options','self_choose','self_appraise','self_preferences','memory_recall','memory_inspect','memory_propose','memory_retract','memory_segments'])
function evidenceText(row){
  const raw=row.result_text??row.text
  if(row.name?.startsWith('mcp__playwright-mcp__'))try{
    const value=JSON.parse(raw)
    if(Array.isArray(value.content))return (value.isError?'[native outcome: error]':'[native outcome: success]')+'\n'+value.content.filter(c=>c.type==='text').map(c=>c.text).join('\n\n')
  }catch{/* Legacy or unstructured tool results keep their original text. */}
  return raw
}

// All identity, visibility and delivery authority is host-owned, not message text.
export class SocialStore {
  constructor(store) {
    this.store=store;this.db=store.db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_targets(handle TEXT PRIMARY KEY,platform TEXT NOT NULL,account TEXT NOT NULL,kind TEXT NOT NULL,peer TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',scope TEXT NOT NULL UNIQUE,approved INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_events(id INTEGER PRIMARY KEY,external_key TEXT NOT NULL UNIQUE,target TEXT NOT NULL REFERENCES yoyo_targets(handle),sender TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,segments TEXT NOT NULL DEFAULT '[]',received_at INTEGER NOT NULL,mentioned INTEGER NOT NULL DEFAULT 0,read_at INTEGER,source_inbox INTEGER UNIQUE);
      CREATE INDEX IF NOT EXISTS yoyo_events_target ON yoyo_events(target,id);
      CREATE TABLE IF NOT EXISTS yoyo_views(id TEXT PRIMARY KEY,focus TEXT,scopes TEXT NOT NULL,authorization_version INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_activity_log(id INTEGER PRIMARY KEY,state TEXT NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_persona_versions(id INTEGER PRIMARY KEY,body TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_activity(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'idle',body TEXT NOT NULL DEFAULT '{}',scopes TEXT NOT NULL DEFAULT '["public"]',wake_at INTEGER,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_turns(request_id TEXT PRIMARY KEY,view_id TEXT NOT NULL REFERENCES yoyo_views(id),state TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS yoyo_tool_sources(run_key TEXT PRIMARY KEY,name TEXT NOT NULL,scopes TEXT NOT NULL,result_text TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_event_scopes(session_id TEXT NOT NULL,seq INTEGER NOT NULL,scopes TEXT NOT NULL,PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS yoyo_memories(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,sources TEXT NOT NULL,confidence TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS yoyo_retirements(memory_id INTEGER PRIMARY KEY,through_id INTEGER NOT NULL,forgotten_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_outbox(id INTEGER PRIMARY KEY,run_key TEXT NOT NULL UNIQUE,target TEXT NOT NULL REFERENCES yoyo_targets(handle),authorization_version INTEGER NOT NULL,view_id TEXT NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,remote_id TEXT,error TEXT,sent_at INTEGER);
      CREATE TABLE IF NOT EXISTS yoyo_navigation(target TEXT PRIMARY KEY,last_opened INTEGER,last_read INTEGER,read_count INTEGER NOT NULL DEFAULT 0,last_message INTEGER);
      CREATE TABLE IF NOT EXISTS yoyo_notices(target TEXT PRIMARY KEY,through_id INTEGER NOT NULL,notified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_attention_policies(target TEXT PRIMARY KEY,body TEXT NOT NULL DEFAULT '{}',last_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS yoyo_attention(target TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS yoyo_usage(day TEXT PRIMARY KEY,steps INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS yoyo_jobs(id TEXT PRIMARY KEY,run_key TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_documents(id INTEGER PRIMARY KEY,url TEXT NOT NULL,body TEXT NOT NULL,scope TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_assets(id TEXT PRIMARY KEY,path TEXT NOT NULL,scopes TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(path,scopes));
      CREATE TABLE IF NOT EXISTS yoyo_plans(id INTEGER PRIMARY KEY,title TEXT NOT NULL,progress TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'open',scopes TEXT NOT NULL,view_id TEXT NOT NULL,not_before INTEGER,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_learning(id INTEGER PRIMARY KEY,body TEXT NOT NULL,scopes TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_learning_versions(id INTEGER PRIMARY KEY,learning_id INTEGER NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_concerns(id INTEGER PRIMARY KEY,body TEXT NOT NULL,scopes TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_concern_feedback(id INTEGER PRIMARY KEY,concern_id INTEGER NOT NULL,body TEXT NOT NULL,scopes TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_concern_wakes(id INTEGER PRIMARY KEY,concern_id INTEGER NOT NULL,scopes TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'review',outcome TEXT,created_at INTEGER NOT NULL,resolved_at INTEGER);
      INSERT OR IGNORE INTO yoyo_activity(id,updated_at) VALUES(1,0);
    `)
    if(!this.db.prepare('PRAGMA table_info(yoyo_outbox)').all().some(c=>c.name==='content'))this.db.exec('ALTER TABLE yoyo_outbox ADD COLUMN content TEXT')
    const jobColumns=this.db.prepare('PRAGMA table_info(yoyo_jobs)').all().map(c=>c.name)
    for(const [name,type] of [['view_id','TEXT'],['state',"TEXT NOT NULL DEFAULT 'running'"],['notified','INTEGER NOT NULL DEFAULT 0'],['next_poll','INTEGER NOT NULL DEFAULT 0'],['backend',"TEXT NOT NULL DEFAULT 'executor'"]])if(!jobColumns.includes(name))this.db.exec('ALTER TABLE yoyo_jobs ADD COLUMN '+name+' '+type)
    if(!this.db.prepare('PRAGMA table_info(yoyo_targets)').all().some(c=>c.name==='muted'))this.db.exec('ALTER TABLE yoyo_targets ADD COLUMN muted INTEGER NOT NULL DEFAULT 0')
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
    return this.db.prepare(`SELECT t.handle,t.platform,t.kind,t.label,t.muted,count(e.id) unread,max(e.mentioned) mentioned,min(e.received_at) oldest,max(e.id) latest FROM yoyo_targets t LEFT JOIN yoyo_events e ON e.target=t.handle AND e.read_at IS NULL WHERE t.approved=1 GROUP BY t.handle ORDER BY mentioned DESC,oldest LIMIT 100`).all().map(t=>({...t,attentionPolicy:t.kind==='group'?this.attentionPolicy(t.handle):null}))
  }
  setMuted(handle,muted) {
    this.target(handle,{approved:true})
    if(typeof muted!=='boolean')throw Error('Invalid mute state')
    this.db.prepare('UPDATE yoyo_targets SET muted=? WHERE handle=?').run(muted?1:0,handle)
    const latest=this.db.prepare('SELECT max(id) id FROM yoyo_events WHERE target=?').get(handle).id
    if(latest)this.acknowledgeAttention([{handle,throughId:latest}],Date.now(),false)
    this.store.audit('yoyo.attention_mute',{target:handle,muted})
    return {target:handle,muted,scope:'agent_attention',retained:true}
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
  attentionPolicy(handle,now=Date.now()) {
    const target=this.target(handle,{approved:true})
    const row=this.db.prepare('SELECT body,last_at FROM yoyo_attention_policies WHERE target=?').get(handle)
    let p=row?JSON.parse(row.body):{}
    if(p.mode==='realtime'&&p.until<=now)p={}
    const recent=this.db.prepare("SELECT count(*) n FROM yoyo_events WHERE target=? AND kind='message' AND received_at>? AND received_at<=?").get(handle,now-300000,now).n
    // A noisy group requires roughly thirty seconds' traffic, with a useful
    // floor and ceiling. Explicit settings override the adaptive defaults.
    const mode=p.mode??'auto',realtime=mode==='realtime'
    return {mode,until:realtime?p.until:null,minMessages:realtime?1:(p.minMessages??Math.min(50,Math.max(3,Math.ceil(recent/10)))),maxWaitMs:realtime?5000:(p.maxWaitMs??120000),minIntervalMs:realtime?0:(p.minIntervalMs??60000),mentionBypass:p.mentionBypass??true,recentMessages:recent,lastNotifiedAt:row?.last_at??0}
  }
  setAttentionPolicy(handle,{mode='auto',durationMs=600000,minMessages,maxWaitMs,minIntervalMs,mentionBypass}={}) {
    if(this.target(handle,{approved:true}).kind!=='group')throw Error('Attention modes apply to groups only')
    if(!['auto','realtime','custom'].includes(mode))throw Error('Invalid attention mode')
    for(const [value,min,max] of [[durationMs,30000,3600000],[minMessages,1,1000],[maxWaitMs,5000,86400000],[minIntervalMs,0,86400000]])if(value!==undefined&&(!Number.isSafeInteger(value)||value<min||value>max))throw Error('Invalid attention threshold')
    if(mentionBypass!==undefined&&typeof mentionBypass!=='boolean')throw Error('Invalid mention policy')
    const body=mode==='realtime'?{mode,until:Date.now()+durationMs,mentionBypass}:mode==='auto'?{mode,mentionBypass}:{mode,minMessages,maxWaitMs,minIntervalMs,mentionBypass}
    this.db.prepare('INSERT INTO yoyo_attention_policies(target,body) VALUES(?,?) ON CONFLICT(target) DO UPDATE SET body=excluded.body').run(handle,JSON.stringify(body))
    this.store.audit('yoyo.attention_policy',{target:handle,...body})
    return this.attentionPolicy(handle)
  }
  attention(now=Date.now(),quietMs=5000) {
    const rows=[]
    for(const t of this.db.prepare('SELECT * FROM yoyo_targets WHERE approved=1 AND muted=0').all()){
      const cursor=this.db.prepare('SELECT cursor FROM yoyo_attention WHERE target=?').get(t.handle)?.cursor??0
      const first=this.db.prepare("SELECT id,received_at FROM yoyo_events WHERE target=? AND id>? AND kind='message' AND read_at IS NULL ORDER BY id LIMIT 1").get(t.handle,cursor)
      if(!first)continue
      let readyAt=first.received_at+quietMs
      const group=t.kind==='group',policy=group?this.attentionPolicy(t.handle,now):null
      const batch=this.db.prepare("SELECT max(id) through_id,count(*) count,max(mentioned) mentioned FROM yoyo_events WHERE target=? AND id>? AND kind='message' AND read_at IS NULL AND received_at<=?").get(t.handle,cursor,group?Math.max(first.received_at,now):readyAt)
      let eligible=true,reason='batch'
      if(policy){
        const mention=policy.mentionBypass&&!!batch.mentioned
        eligible=mention||batch.count>=policy.minMessages||now>=first.received_at+policy.maxWaitMs
        reason=mention?'mention':batch.count>=policy.minMessages?'volume':'max_wait'
        readyAt=Math.max(readyAt,policy.lastNotifiedAt+policy.minIntervalMs)
      }
      rows.push({handle:t.handle,platform:t.platform,kind:t.kind,label:t.label,readyAt,ready:now>=readyAt&&eligible,throughId:batch.through_id,count:batch.count,mentioned:!!batch.mentioned,reason,...(policy?{policy}:{})})
    }
    return rows
  }
  navigation() {
    return this.db.prepare('SELECT t.handle,t.kind,t.label,n.last_opened,n.last_read,n.read_count,n.last_message FROM yoyo_navigation n JOIN yoyo_targets t ON t.handle=n.target WHERE t.approved=1 ORDER BY coalesce(n.last_read,n.last_opened) DESC LIMIT 30').all()
  }
  recordFocus(handle){this.target(handle,{approved:true});this.db.prepare('INSERT INTO yoyo_navigation(target,last_opened) VALUES(?,?) ON CONFLICT(target) DO UPDATE SET last_opened=excluded.last_opened').run(handle,Date.now())}
  pendingNotices() {
    return this.db.prepare(`SELECT t.handle,t.kind,t.label,count(e.id) unread,max(e.id) latest,n.notified_at FROM yoyo_notices n JOIN yoyo_targets t ON t.handle=n.target JOIN yoyo_events e ON e.target=t.handle AND e.id<=n.through_id AND e.read_at IS NULL AND e.kind='message' WHERE t.approved=1 AND t.muted=0 GROUP BY t.handle`).all()
  }
  dismissNotice(handle){this.target(handle,{approved:true});this.db.prepare('DELETE FROM yoyo_notices WHERE target=?').run(handle);return {target:handle,dismissed:true,markedRead:false}}
  acknowledgeAttention(batches,now=Date.now(),presented=true){
    for(const b of batches){
      if(presented)this.db.prepare('INSERT INTO yoyo_notices VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET through_id=max(through_id,excluded.through_id),notified_at=excluded.notified_at').run(b.handle,b.throughId,now)
      this.db.prepare('INSERT INTO yoyo_attention VALUES(?,?) ON CONFLICT(target) DO UPDATE SET cursor=max(cursor,excluded.cursor)').run(b.handle,b.throughId)
      this.db.prepare('INSERT INTO yoyo_attention_policies(target,last_at) VALUES(?,?) ON CONFLICT(target) DO UPDATE SET last_at=max(last_at,excluded.last_at)').run(b.handle,now)
    }
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
  read(viewId,{after,before=Number.MAX_SAFE_INTEGER,limit=30,query=''}={}) {
    const view=this.view(viewId)
    if(!view.focus)throw Error('请先选择要阅读的聊天窗口')
    if(!Number.isSafeInteger(before)||before<0||after!==undefined&&(!Number.isInteger(after)||after<0)||!Number.isInteger(limit)||limit<1||limit>50||typeof query!=='string'||query.length>300)throw Error('读取范围无效')
    if(after===undefined){const first=this.db.prepare('SELECT min(id) n FROM yoyo_events WHERE target=? AND read_at IS NULL').get(view.focus).n;after=first?Math.max(0,first-4):Math.max(0,(this.db.prepare('SELECT max(id) n FROM yoyo_events WHERE target=?').get(view.focus).n??0)-limit)}
    return this.db.prepare('SELECT id,sender,kind,text,segments,received_at,mentioned,source_inbox FROM yoyo_events WHERE target=? AND id>? AND id<=? AND instr(lower(text),lower(?))>0 ORDER BY id LIMIT ?').all(view.focus,after,before,query,limit).map(r=>({...r,segments:JSON.parse(r.segments)}))
  }
  markRead(viewId,ids) {
    const v=this.view(viewId);if(!Array.isArray(ids)||ids.length>50||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('原文编号无效')
    this.store.transaction(()=>{
      if(ids.length&&v.focus)this.db.prepare('INSERT INTO yoyo_navigation(target,last_read,read_count,last_message) VALUES(?,?,?,?) ON CONFLICT(target) DO UPDATE SET last_read=excluded.last_read,read_count=read_count+excluded.read_count,last_message=max(coalesce(last_message,0),excluded.last_message)').run(v.focus,Date.now(),ids.length,Math.max(...ids))
      for(const id of ids){
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
    this.db.prepare('UPDATE yoyo_activity SET revision=revision+1,state=?,body=?,scopes=?,wake_at=?,updated_at=? WHERE id=1').run(state,JSON.stringify({description,next,viewId}),JSON.stringify(view.scopes),wakeAt,Date.now())
    this.db.prepare('INSERT INTO yoyo_activity_log(state,body,scopes,created_at) VALUES(?,?,?,?)').run(state,JSON.stringify({description,next}),JSON.stringify(view.scopes),Date.now())
    return this.activity(viewId)
  }
  activityHistory(viewId){const view=this.view(viewId);return this.db.prepare("SELECT state,body,created_at FROM yoyo_activity_log l WHERE NOT EXISTS(SELECT 1 FROM json_each(l.scopes) s WHERE s.value NOT IN(SELECT value FROM json_each(?))) ORDER BY id DESC LIMIT 20").all(JSON.stringify(view.scopes)).map(r=>({...r,body:JSON.parse(r.body)}))}
  concerns(viewId) {
    const view=this.view(viewId)
    const wakes=this.concernWakeStats(viewId)
    return this.db.prepare('SELECT * FROM yoyo_concerns c WHERE NOT EXISTS(SELECT 1 FROM json_each(c.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?))) ORDER BY updated_at DESC LIMIT 100').all(JSON.stringify(view.scopes))
      .map(r=>({id:r.id,...JSON.parse(r.body),wakes:wakes.get(r.id)??{delivered:0,effective:0,deferred:0,dropped:0,ignored:0,open:0},updatedAt:r.updated_at}))
  }
  concern(viewId,args) {
    const visible=this.concerns(viewId),view=this.view(viewId)
    const previous=args.id===undefined?null:visible.find(r=>r.id===args.id)
    if(args.id!==undefined&&!previous)throw Error('关切不存在或不在当前资料范围')
    const body={...previous,...args};delete body.id;delete body.updatedAt;delete body.wakes
    for(const field of ['title','why','origin','next','doneWhen','stopWhen'])body[field]=boundedText(body[field],field==='title'?300:1500)
    body.state??='active'
    if(!['active','waiting','done','abandoned'].includes(body.state))throw Error('关切状态无效')
    body.reviewAt??=null
    if(args.reviewAt!==undefined&&body.reviewAt!==null&&(!Number.isSafeInteger(body.reviewAt)||body.reviewAt<=Date.now()||body.reviewAt>Date.now()+30*86400000))throw Error('复查时间无效')
    // Updating a concern from a broader view also broadens its input provenance.
    body.viewId=viewId
    const scopes=JSON.stringify(sourceScopes(view.scopes)),now=Date.now()
    if(previous)this.db.prepare('UPDATE yoyo_concerns SET body=?,scopes=?,updated_at=? WHERE id=?').run(JSON.stringify(body),scopes,now,previous.id)
    const id=previous?.id??Number(this.db.prepare('INSERT INTO yoyo_concerns(body,scopes,updated_at) VALUES(?,?,?)').run(JSON.stringify(body),scopes,now).lastInsertRowid)
    // Closing a concern is a decision about the concern itself, so the wakes that
    // led here are resolved instead of staying open forever.
    if(body.state==='done'||body.state==='abandoned')this.decideConcernWake(id,body.state==='done'?'done':'abandon')
    return {id,state:body.state}
  }
  learning(viewId) {
    const view=this.view(viewId)
    return this.db.prepare('SELECT id,body,updated_at FROM yoyo_learning l WHERE NOT EXISTS(SELECT 1 FROM json_each(l.scopes) s WHERE s.value NOT IN(SELECT value FROM json_each(?))) ORDER BY updated_at DESC LIMIT 50').all(JSON.stringify(view.scopes)).map(r=>({id:r.id,...JSON.parse(r.body),updatedAt:r.updated_at}))
  }
  learn(viewId,args) {
    const view=this.view(viewId),previous=args.id===undefined?null:this.learning(viewId).find(r=>r.id===args.id)
    if(args.id!==undefined&&!previous)throw Error('学习意图不存在或不在当前资料范围')
    const body={...previous,...args};delete body.id;delete body.updatedAt
    for(const field of ['trait','admiration','trial'])body[field]=boundedText(body[field],1500)
    body.state??='proposed'
    if(!['proposed','trial','adopted','retired'].includes(body.state))throw Error('学习状态无效')
    if(!Array.isArray(body.sources)||body.sources.length<2||body.sources.length>10)throw Error('欣赏对象至少需要两条直接经历证据')
    const identities=[]
    for(const source of body.sources){
      if(!Number.isSafeInteger(source.id)||typeof source.quote!=='string'||!source.quote.trim())throw Error('学习证据无效')
      const row=this.db.prepare('SELECT e.*,t.platform,t.account FROM yoyo_events e JOIN yoyo_targets t ON e.target=t.handle WHERE e.id=?').get(source.id)
      if(!row||!mayRead(view,row.scope)||row.kind!=='message'||!row.text.includes(source.quote)||JSON.parse(row.segments).some(s=>s.type==='forward'))throw Error('学习依据须为当前可见的本人直接原文，不接受转发')
      identities.push(JSON.stringify([row.platform,row.account,row.sender]))
    }
    if(new Set(body.sources.map(s=>s.id)).size<2||new Set(identities).size!==1)throw Error('学习对象必须是同一稳定身份，且有独立原文')
    body.identity=JSON.parse(identities[0])
    if(previous&&JSON.stringify(previous.identity)!==JSON.stringify(body.identity))throw Error('更换欣赏对象应创建新的学习意图')
    if(body.state==='adopted'){
      if(!previous||!['trial','adopted'].includes(previous.state))throw Error('需要先记录尝试，再决定保留')
      if(previous.state==='adopted'&&['trait','admiration','trial'].some(k=>body[k]!==previous[k]))throw Error('改变学习内容需要重新进入 trial')
      body.review=boundedText(body.review,1500)
      if(typeof body.trialReceipt!=='string')throw Error('保留学习结果需要实际尝试回执')
      const receipt=this.db.prepare('SELECT name,scopes,result_text,created_at FROM yoyo_tool_sources WHERE run_key=?').get(body.trialReceipt)
      if(!receipt||!['yoyo_send','yoyo_job'].includes(receipt.name)||!JSON.parse(receipt.scopes).every(s=>mayRead(view,s)))throw Error('尝试回执不存在或不在当前资料范围')
      if(previous.state==='trial'&&receipt.created_at<previous.updatedAt)throw Error('尝试回执早于本轮学习尝试')
      if(receipt.name==='yoyo_send'&&!this.db.prepare("SELECT 1 FROM yoyo_outbox WHERE run_key=? AND state='sent'").get(body.trialReceipt))throw Error('发信尚未确认，不能作为已尝试证据')
      if(receipt.name==='yoyo_job'&&JSON.parse(receipt.result_text).state!=='done')throw Error('尝试任务尚未完成')
      body.reviewConfidence='self_report'
    }
    const scopes=JSON.stringify(sourceScopes(view.scopes)),now=Date.now()
    return this.store.transaction(()=>{
      let id=previous?.id
      if(id)this.db.prepare('UPDATE yoyo_learning SET body=?,scopes=?,updated_at=? WHERE id=?').run(JSON.stringify(body),scopes,now,id)
      else id=Number(this.db.prepare('INSERT INTO yoyo_learning(body,scopes,updated_at) VALUES(?,?,?)').run(JSON.stringify(body),scopes,now).lastInsertRowid)
      this.db.prepare('INSERT INTO yoyo_learning_versions(learning_id,body,scopes,created_at) VALUES(?,?,?,?)').run(id,JSON.stringify(body),scopes,now)
      return {id,state:body.state,identity:body.identity}
    })
  }
  dueConcern(now=Date.now()) {
    const rows=this.db.prepare("SELECT id,body,scopes FROM yoyo_concerns WHERE json_extract(body,'$.state') IN ('active','waiting') AND json_extract(body,'$.reviewAt')<=? ORDER BY json_extract(body,'$.reviewAt'),id").all(now)
    for(const r of rows){try{const body=JSON.parse(r.body),view=this.view(body.viewId);if(!JSON.parse(r.scopes).every(s=>mayRead(view,s)))continue;return {id:r.id,...body,view}}catch{/* Revoked or legacy concerns do not wake another scope. */}}
    return null
  }
  consumeConcernReview(id,reviewAt) {
    // Compare-and-clear so a new decision made while this turn runs survives.
    const result=this.db.prepare("UPDATE yoyo_concerns SET body=json_set(body,'$.reviewAt',NULL) WHERE id=? AND json_extract(body,'$.reviewAt')=?").run(id,reviewAt)
    // A delivered review is a wake. Being woken again before deciding anything
    // means the earlier one achieved nothing, so only counts are kept honest.
    if(result.changes){
      const row=this.db.prepare('SELECT scopes FROM yoyo_concerns WHERE id=?').get(id)
      if(row)this.noteConcernWake(id,row.scopes)
    }
  }
  noteConcernWake(concernId,scopes,reason='review') {
    const now=Date.now()
    this.db.prepare("UPDATE yoyo_concern_wakes SET outcome='ignored',resolved_at=? WHERE concern_id=? AND outcome IS NULL").run(now,concernId)
    this.db.prepare('INSERT INTO yoyo_concern_wakes(concern_id,scopes,reason,outcome,created_at) VALUES(?,?,?,NULL,?)')
      .run(concernId,Array.isArray(scopes)?JSON.stringify(scopes):String(scopes),reason,now)
  }
  // A decision is the only thing that turns a wake into a result. "任务完成"
  // is not a concern decision, so team reviews never resolve these.
  decideConcernWake(concernId,decision) {
    const outcome=decision==='done'?'effective':decision==='abandon'?'dropped':'deferred'
    this.db.prepare('UPDATE yoyo_concern_wakes SET outcome=?,resolved_at=? WHERE concern_id=? AND outcome IS NULL')
      .run(outcome,Date.now(),concernId)
    return outcome
  }
  concernWakeStats(viewId) {
    const view=this.view(viewId),stats=new Map()
    for(const row of this.db.prepare(`SELECT w.concern_id,w.outcome,count(*) n FROM yoyo_concern_wakes w
      WHERE NOT EXISTS(SELECT 1 FROM json_each(w.scopes) s WHERE s.value NOT IN (SELECT value FROM json_each(?))) GROUP BY w.concern_id,w.outcome`)
      .all(JSON.stringify(view.scopes))){
      const entry=stats.get(row.concern_id)??{delivered:0,effective:0,deferred:0,dropped:0,ignored:0,open:0}
      entry.delivered+=row.n
      if(row.outcome==='effective')entry.effective+=row.n
      else if(row.outcome==='dropped')entry.dropped+=row.n
      else if(row.outcome==='deferred')entry.deferred+=row.n
      else if(row.outcome==='ignored')entry.ignored+=row.n
      else entry.open+=row.n
      stats.set(row.concern_id,entry)
    }
    return stats
  }
  concernFeedback(viewId,{id,outcome,decision,receipt}) {
    const view=this.view(viewId),concern=this.concerns(viewId).find(r=>r.id===id)
    if(!concern)throw Error('关切不存在或不在当前资料范围')
    outcome=boundedText(outcome,2000)
    if(!['continue','revise','wait','done','abandon'].includes(decision))throw Error('反馈决定无效')
    if(receipt!==undefined){
      const source=this.db.prepare("SELECT scopes,name FROM yoyo_tool_sources WHERE run_key=?").get(receipt)
      if(!source||['yoyo_concern','yoyo_feedback','yoyo_self','yoyo_memory','yoyo_forget','yoyo_recall','self_options','self_choose','self_appraise','self_preferences','memory_recall','memory_inspect','memory_propose','memory_retract'].includes(source.name)||!JSON.parse(source.scopes).every(s=>mayRead(view,s)))throw Error('反馈回执不存在或不在当前资料范围')
    }
    const body={outcome,decision,receipt:receipt??null,evidence:receipt?'tool_receipt':'self_report'}
    const result=this.db.prepare('INSERT INTO yoyo_concern_feedback(concern_id,body,scopes,created_at) VALUES(?,?,?,?)').run(id,JSON.stringify(body),JSON.stringify(sourceScopes(view.scopes)),Date.now())
    // Only a concern-level decision resolves the wake that led here.
    this.decideConcernWake(id,decision)
    // Feedback is a report, not automatic proof of success. Update the explicit
    // concern via its tool when next/criteria/state need changing.
    return {id:Number(result.lastInsertRowid),...body}
  }
  concernFeedbacks(viewId) {
    const view=this.view(viewId)
    return this.db.prepare('SELECT id,concern_id,body,created_at FROM yoyo_concern_feedback f WHERE NOT EXISTS(SELECT 1 FROM json_each(f.scopes) s WHERE s.value NOT IN(SELECT value FROM json_each(?))) ORDER BY id DESC LIMIT 20').all(JSON.stringify(view.scopes)).map(r=>({id:r.id,concern:r.concern_id,...JSON.parse(r.body),at:r.created_at}))
  }
  evidence(viewId,{limit=10}={}) {
    const view=this.view(viewId)
    if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('证据条数无效')
    return this.db.prepare('SELECT run_key,name,result_text,created_at FROM yoyo_tool_sources r WHERE NOT EXISTS(SELECT 1 FROM json_each(r.scopes) s WHERE s.value NOT IN(SELECT value FROM json_each(?))) AND name NOT IN ('+[...NARRATIVE_TOOLS].map(()=>'?').join(',')+') ORDER BY created_at DESC,rowid DESC LIMIT ?').all(JSON.stringify(view.scopes),...NARRATIVE_TOOLS,limit).map(r=>{const text=evidenceText(r);return {receipt:r.run_key,name:r.name,text:text.slice(0,4000),truncated:text.length>4000,at:r.created_at}})
  }
  remember(viewId,{kind='episodes',body,sources=[],confidence='observed',expiresAt=null}) {
    const view=this.view(viewId);body=boundedText(body,2000)
    if(!['episodes','profile','relations','knowledge','procedures','intention','communication'].includes(kind)||!['observed','hypothesis','self_report'].includes(confidence)||!Array.isArray(sources)||!sources.length||sources.length>10||expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()))throw Error('记忆类型或来源无效')
    for(const s of sources){
      if(!s||typeof s!=='object'||[s.id,s.document,s.receipt].filter(v=>v!==undefined).length!==1||(s.receipt!==undefined?(typeof s.receipt!=='string'||s.receipt.length>500):!Number.isSafeInteger(s.document??s.id)))throw Error('原文来源编号无效')
      const row=s.receipt!==undefined?this.db.prepare('SELECT name,result_text text,scopes FROM yoyo_tool_sources WHERE run_key=?').get(s.receipt):s.document!==undefined?this.db.prepare('SELECT body text,scope FROM yoyo_documents WHERE id=?').get(s.document):this.db.prepare('SELECT text,scope FROM yoyo_events WHERE id=?').get(s.id)
      if(s.receipt!==undefined&&row){if(NARRATIVE_TOOLS.has(row.name)&&(confidence!=='self_report'||kind==='procedures'))throw Error('自述只能记录为 self_report，不能作为实际执行证据');row.text=evidenceText(row)}
      if(!row||!(row.scopes?JSON.parse(row.scopes).every(s=>mayRead(view,s)):mayRead(view,row.scope))||typeof s.quote!=='string'||!s.quote.trim()||!row.text.includes(s.quote))throw Error('记忆必须有当前可见原文的逐字证据')
    }
    if(kind==='procedures'&&confidence==='observed'&&!sources.some(s=>s.receipt!==undefined))throw Error('已验证流程需要实际工具回执；未实测的方法请标 hypothesis')
    if(kind==='communication'){
      const direct=sources.filter(s=>s.id!==undefined).map(s=>this.db.prepare('SELECT id,sender,kind,segments FROM yoyo_events WHERE id=?').get(s.id)).filter(r=>r?.kind==='message'&&!JSON.parse(r.segments).some(s=>s.type==='forward'))
      if(!direct.length||new Set(direct.map(r=>r.sender)).size!==1)throw Error('语言习惯须有同一实际发送者的直接原文，不能混合人物或转发')
      if(confidence==='observed'&&new Set(direct.map(r=>r.id)).size<2)throw Error('稳定语言观察至少需要两条独立原文；单次原因推断请标 hypothesis，明确自述标 self_report')
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
  enqueueAsset(viewId,target,content,runKey,now=Date.now()) {
    const view=this.view(viewId),asset=this.db.prepare('SELECT * FROM yoyo_assets WHERE id=?').get(content?.assetId)
    if(!asset||!JSON.parse(asset.scopes).every(s=>mayRead(view,s)))throw Error('文件不在当前资料范围')
    assertPublish(JSON.parse(asset.scopes),this.target(target,{approved:true}).scope)
    if(!['image','file'].includes(content.kind)||!Number.isSafeInteger(content.bytes)||content.bytes<1||content.bytes>8*1024*1024||!/^([a-f0-9]{64})$/.test(content.sha256))throw Error('发送文件元数据无效')
    return this.store.transaction(()=>{
      const result=this.enqueue(viewId,target,'['+(content.kind==='image'?'图片':'文件')+'] '+asset.name,runKey,now)
      const encoded=JSON.stringify({...content,name:asset.name}),old=this.db.prepare('SELECT content FROM yoyo_outbox WHERE id=?').get(result.id)
      if(old.content&&old.content!==encoded)throw Error('同一动作不能更换附件')
      this.db.prepare('UPDATE yoyo_outbox SET content=? WHERE id=?').run(encoded,result.id);return result
    })
  }
  async deliver(send,now=Date.now(),{ownerOnly=false}={}) {
    const row=this.db.prepare("SELECT * FROM yoyo_outbox WHERE state IN ('queued','retry_wait') AND next_at<=? AND (?=0 OR target IN (SELECT handle FROM yoyo_targets WHERE platform='wechat' AND kind='owner')) ORDER BY id LIMIT 1").get(now,ownerOnly?1:0)
    if(!row)return false
    const authorize=()=>{try{const t=this.target(row.target,{approved:true});if(t.version!==row.authorization_version||row.expires_at<Math.max(now,Date.now()))throw Error('授权已变化或回复已过期');this.view(row.view_id);assertPublish(JSON.parse(row.scopes),t.scope)}catch(e){e.authorityInvalid=true;throw e}}
    try{authorize()}
    catch(e){this.db.prepare("UPDATE yoyo_outbox SET state='cancelled',error=? WHERE id=?").run(e.message,row.id);return false}
    this.db.prepare("UPDATE yoyo_outbox SET state='sending',attempts=attempts+1 WHERE id=?").run(row.id)
    try{
      const result=await send(this.target(row.target),row.body,'yoyo-'+createHash('sha256').update(row.run_key).digest('hex').slice(0,24),authorize,row.content?JSON.parse(row.content):null)
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
