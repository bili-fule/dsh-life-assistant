import {localParts} from './time.mjs'

// Scheduling is deterministic; the existing native agent does the actual review.
export class SocialMaintenance {
 constructor(data,config={}){
  this.data=data;this.db=data.db
  // pageEvents bounds how much one review may cover: a backlog is consolidated in
  // pages instead of one oversized native turn. Night runs once per local day.
  this.config={idleMs:120000,cooldownMs:1800000,nightHour:2,pageEvents:120,...config}
  if(!Number.isInteger(this.config.pageEvents)||this.config.pageEvents<1||this.config.pageEvents>1000)throw Error('整理分页条数无效')
  this.db.exec(`CREATE TABLE IF NOT EXISTS yoyo_memory_jobs(id INTEGER PRIMARY KEY,target TEXT NOT NULL,through_id INTEGER NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT,created_at INTEGER NOT NULL,finished_at INTEGER,error TEXT,UNIQUE(target,through_id,kind));CREATE TABLE IF NOT EXISTS yoyo_memory_cursors(target TEXT PRIMARY KEY,through_id INTEGER NOT NULL DEFAULT 0,last_idle INTEGER NOT NULL DEFAULT 0,last_night TEXT);`)
  this.db.prepare("UPDATE yoyo_memory_jobs SET state='interrupted',finished_at=?,error='服务重启，未重复执行已提交的整理' WHERE state='running'").run(Date.now())
 }
 next(now=Date.now()){return this.plan(now).job}
 // The same decision with its reason spelled out: a quiet night produces an
 // explained skip instead of a model call, so "nothing happened" stays legible.
 plan(now=Date.now()){
  const {date,hour}=localParts(now),night=hour>=this.config.nightHour&&hour<this.config.nightHour+4
  const rows=this.db.prepare(`SELECT t.handle,max(e.id) through_id,max(e.received_at) latest,count(e.id) count FROM yoyo_targets t JOIN yoyo_events e ON e.target=t.handle LEFT JOIN yoyo_memory_cursors c ON c.target=t.handle WHERE t.approved=1 AND t.platform='qq' AND e.kind='message' AND e.read_at IS NOT NULL AND e.id>coalesce(c.through_id,0) GROUP BY t.handle ORDER BY latest`).all()
  if(!rows.length)return {job:null,reason:'没有新的可整理原文'}
  const skipped=[]
  for(const r of rows){
   const cursor=this.db.prepare('SELECT * FROM yoyo_memory_cursors WHERE target=?').get(r.handle)
   const latest=this.db.prepare('SELECT max(received_at) n FROM yoyo_events WHERE target=?').get(r.handle).n
   if(now-latest<this.config.idleMs){skipped.push('对话还没结束');continue}
   const kind=night&&cursor?.last_night!==date?'night':'idle'
   if(kind==='idle'&&now-(cursor?.last_idle??0)<this.config.cooldownMs){skipped.push('冷却中');continue}
   // One review covers a bounded page, so a long backlog is never sent whole.
   const after=cursor?.through_id??0,through=Math.min(r.through_id,after+this.config.pageEvents)
   // A failed range is visible for inspection; do not spin on it every tick.
   const previous=this.db.prepare('SELECT id,state FROM yoyo_memory_jobs WHERE target=? AND through_id=? AND kind=?').get(r.handle,through,kind)
   if(previous&&previous.state!=='retry'){skipped.push('这段整理失败，等待重试');continue}
   return {job:{target:r.handle,after,through,kind,day:date,retryId:previous?.state==='retry'?previous.id:null,pageSize:this.config.pageEvents},reason:null}
  }
  return {job:null,reason:[...new Set(skipped)].join('；')}
 }
 claim(job,requestId,now=Date.now()){
  this.data.target(job.target,{approved:true})
  if(job.retryId){const r=this.db.prepare("UPDATE yoyo_memory_jobs SET state='running',request_id=?,created_at=?,finished_at=NULL,error=NULL WHERE id=? AND state='retry'").run(requestId,now,job.retryId);if(!r.changes)throw Error('整理重试状态已变化');return {...job,id:job.retryId}}
  const id=Number(this.db.prepare("INSERT INTO yoyo_memory_jobs(target,through_id,kind,day,state,request_id,created_at) VALUES(?,?,?,?,'running',?,?)").run(job.target,job.through,job.kind,job.day,requestId,now).lastInsertRowid)
  return {...job,id}
 }
 finish(job,{ok,error=null},now=Date.now()){
  this.data.store.transaction(()=>{
   this.db.prepare('UPDATE yoyo_memory_jobs SET state=?,finished_at=?,error=? WHERE id=?').run(ok?'done':'failed',now,error,job.id)
   if(ok)this.db.prepare(`INSERT INTO yoyo_memory_cursors VALUES(?,?,?,?) ON CONFLICT(target) DO UPDATE SET through_id=max(through_id,excluded.through_id),last_idle=excluded.last_idle,last_night=coalesce(excluded.last_night,last_night)`).run(job.target,job.through,now,job.kind==='night'?job.day:null)
  })
 }
 retry(id){const job=this.db.prepare('SELECT * FROM yoyo_memory_jobs WHERE id=?').get(id);if(!job||!['failed','interrupted'].includes(job.state))throw Error('此整理任务不能重试');this.data.target(job.target,{approved:true});this.db.prepare("UPDATE yoyo_memory_jobs SET state='retry' WHERE id=?").run(id);return {scheduled:true}}
 status(){return {jobs:this.db.prepare('SELECT id,target,through_id,kind,state,created_at,finished_at,error FROM yoyo_memory_jobs ORDER BY id DESC LIMIT 12').all(),cursors:this.db.prepare('SELECT * FROM yoyo_memory_cursors').all(),next:this.plan()}}
}
