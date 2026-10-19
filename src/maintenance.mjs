import { localParts } from './time.mjs'
import { directSource } from './memory.mjs'

export class Maintenance {
  constructor(runtime,config={}) {this.runtime=runtime;this.store=runtime.store;this.idleMs=Math.max(1000,Number(config.memoryIdleMs)||300000);this.nightHour=Number.isInteger(config.maintenanceHour)?config.maintenanceHour:3;this.active=null}
  status(){return {idleSeconds:this.idleMs/1000,nightHour:this.nightHour,active:this.active?.key??null,last:this.store.get('maintenance_last'),jobs:this.store.db.prepare('SELECT key,kind,state,phase,attempts,error,finished_at FROM maintenance_jobs ORDER BY created_at DESC LIMIT 5').all()}}
  next(now=Date.now()) {
    const db=this.store.db
    if(!this.store.get('native_session_id')||db.prepare("SELECT 1 FROM inbox WHERE state IN ('pending','processing') LIMIT 1").get())return null
    const last=db.prepare("SELECT max(id) id,max(received_at) at FROM inbox WHERE state='done'").get()
    if(!last.id||now-Math.max(last.at,this.store.get('conversation_finished_at',last.at))<this.idleMs)return null
    const prior=db.prepare("SELECT * FROM maintenance_jobs WHERE state IN ('pending','running') AND next_at<=? ORDER BY created_at LIMIT 1").get(now)
    if(prior)return prior
    const p=localParts(now),night=p.hour>=this.nightHour&&p.hour<8
    const cursor=this.store.get('memory_reviewed_through',0)
    let kind,key,through=last.id
    const backlog=db.prepare("SELECT count(*) n FROM inbox WHERE state='done' AND id>?").get(cursor).n
    if(night&&backlog<=30&&!db.prepare('SELECT 1 FROM maintenance_jobs WHERE key=?').get('night:'+p.date)){kind='night';key='night:'+p.date}
    else if(last.id>cursor){kind='idle';const rows=db.prepare("SELECT id FROM inbox WHERE state='done' AND id>? ORDER BY id LIMIT 30").all(cursor);through=rows.at(-1).id;key='idle:'+through+':'+p.date}
    else return null
    if(db.prepare('SELECT 1 FROM maintenance_jobs WHERE key=?').get(key))return null
    db.prepare("INSERT INTO maintenance_jobs(key,kind,through_id,state,created_at) VALUES (?,?,?,'pending',?)").run(key,kind,through,now)
    return db.prepare('SELECT * FROM maintenance_jobs WHERE key=?').get(key)
  }
  sources(job) {
    const cursor=this.store.get('memory_reviewed_through',0)
    return this.store.db.prepare("SELECT id FROM inbox WHERE state='done' AND id<=? AND id>? ORDER BY id LIMIT 30").all(job.through_id,cursor).map(r=>directSource(this.store,r.id)).filter(Boolean).map(r=>({id:r.id,received_at:r.received_at,direct_text:r.direct_text.slice(0,1800),truncated:r.direct_text.length>1800}))
  }
  async run(job) {
    this.active=job
    const db=this.store.db
    try {
      if(job.phase!=='memory')db.prepare("UPDATE maintenance_jobs SET state='running',attempts=attempts+1 WHERE key=?").run(job.key)
      if(job.phase==='memory') {
        // A running receipt is recovered first. A failed/interrupted turn receives a new ID only on the next bounded attempt.
        const requestId=job.state==='running'?job.request_id:`maintenance:${job.key}:${job.attempts+1}`
        db.prepare("UPDATE maintenance_jobs SET state='running',request_id=?,attempts=attempts+? WHERE key=?").run(requestId,job.state==='running'?0:1,job.key)
        await this.runtime.model.maintain({...job,request_id:requestId},this.sources(job))
        const reviewed=job.kind==='night'?Math.max(this.store.get('memory_reviewed_through',0),...this.sources(job).map(s=>s.id),0):job.through_id
        this.store.set('memory_reviewed_through',reviewed)
        db.prepare("UPDATE maintenance_jobs SET phase='compact',error=NULL WHERE key=?").run(job.key)
      }
      if(job.kind==='night') {
        if(db.prepare("SELECT 1 FROM inbox WHERE state IN ('pending','processing') LIMIT 1").get()) {
          db.prepare("UPDATE maintenance_jobs SET state='pending',next_at=? WHERE key=?").run(Date.now()+this.idleMs,job.key);return
        }
        await this.runtime.model.compact()
      }
      db.prepare("UPDATE maintenance_jobs SET state='done',error=NULL,finished_at=? WHERE key=?").run(Date.now(),job.key)
      this.store.set('maintenance_last',{kind:job.kind,throughId:job.through_id,at:Date.now()})
      this.store.audit('maintenance.done',{key:job.key,kind:job.kind})
    } catch(e) {
      const attempts=db.prepare('SELECT attempts FROM maintenance_jobs WHERE key=?').get(job.key).attempts
      db.prepare('UPDATE maintenance_jobs SET state=?,next_at=?,error=? WHERE key=?').run(attempts>=3?'failed':'pending',Date.now()+60000*Math.max(1,attempts),String(e.message).slice(0,300),job.key)
      this.store.audit('maintenance.error',{key:job.key,message:String(e.message).slice(0,200)})
    } finally {this.active=null}
  }
}
