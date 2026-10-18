import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

export function normalizeTitle(s) { return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }
export function messageKey(msg) { return String(msg.message_id ?? msg.msg_id ?? msg.msgid ?? createHash('sha256').update(JSON.stringify(msg)).digest('hex')) }
export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY, external_id TEXT UNIQUE NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,error TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,title TEXT NOT NULL,title_key TEXT NOT NULL,status TEXT NOT NULL,due_at INTEGER,remind_at INTEGER,priority TEXT NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,source_id INTEGER REFERENCES inbox(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER DEFAULT 1);
      CREATE INDEX IF NOT EXISTS task_status ON tasks(status,remind_at);
      CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,source_id INTEGER REFERENCES inbox(id),created_at INTEGER NOT NULL,active INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS checkpoints(id INTEGER PRIMARY KEY,through_id INTEGER NOT NULL,summary TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,unique_key TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,task_id INTEGER,revision INTEGER,state TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,created_at INTEGER NOT NULL,sent_at INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,action TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wire_messages(external_id TEXT PRIMARY KEY,payload TEXT NOT NULL,received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_context(inbox_id INTEGER PRIMARY KEY REFERENCES inbox(id),context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_runs(run_key TEXT PRIMARY KEY,inbox_id INTEGER,name TEXT NOT NULL,args TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(state,next_at);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state,next_at);
    `)
    this.db.exec("UPDATE inbox SET state='pending' WHERE state='processing'; UPDATE outbox SET state='pending' WHERE state='sending';")
  }
  close() { this.db.close() }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn(); this.db.exec('COMMIT'); return r } catch(e) { this.db.exec('ROLLBACK'); throw e } }
  get(key, fallback = null) { const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  audit(action, detail) { this.db.prepare('INSERT INTO audit(action,detail,created_at) VALUES (?,?,?)').run(action, JSON.stringify(detail), Date.now()) }
  ingest(externalId, sender, text, now = Date.now()) { return Number(this.db.prepare('INSERT OR IGNORE INTO inbox(external_id,sender,text,received_at) VALUES (?,?,?,?)').run(externalId,sender,text,now).changes) }
  captureMessage(raw) {this.db.prepare('INSERT OR IGNORE INTO wire_messages VALUES (?,?,?)').run(messageKey(raw),JSON.stringify(raw),Date.now())}
  inputContext(id) {const row=this.db.prepare('SELECT context FROM inbox_context WHERE inbox_id=?').get(id);return row?JSON.parse(row.context):null}
  setInputContext(id,context) {this.db.prepare('INSERT INTO inbox_context VALUES (?,?) ON CONFLICT(inbox_id) DO UPDATE SET context=excluded.context').run(id,JSON.stringify(context))}
  recentAssets() {return this.db.prepare("SELECT inbox_id,context FROM inbox_context WHERE json_array_length(context,'$.assets')>0 ORDER BY inbox_id DESC LIMIT 16").all().flatMap(r=>(JSON.parse(r.context).assets??[]).map(a=>({...a,inboxId:r.inbox_id}))).slice(0,100)}
  nextMessage(now=Date.now()) { return this.db.prepare("SELECT * FROM inbox WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 1").get(now) }
  tasks(all=false) { return this.db.prepare(`SELECT * FROM tasks ${all ? '' : "WHERE status IN ('open','confirm','waiting')"} ORDER BY CASE status WHEN 'confirm' THEN 1 WHEN 'open' THEN 0 ELSE 2 END, due_at IS NULL,due_at,id DESC LIMIT 200`).all() }
  task(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) }
  createTask(t, sourceId, now=Date.now()) {
    const key=normalizeTitle(t.title)
    const dupe=this.db.prepare("SELECT * FROM tasks WHERE title_key=? AND status IN ('open','confirm','waiting') AND (due_at IS ? OR due_at=?) LIMIT 1").get(key,t.due_at,t.due_at)
    if (dupe) return { id: dupe.id, duplicate:true }
    const r=this.db.prepare('INSERT INTO tasks(title,title_key,status,due_at,remind_at,priority,reason,evidence,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(t.title,key,t.status,t.due_at,t.remind_at,t.priority,t.reason,t.evidence,sourceId,now,now)
    return { id:Number(r.lastInsertRowid), duplicate:false }
  }
  updateTask(id, patch, now=Date.now()) {
    const old=this.task(id)
    if (!old) throw Error(`没有待办 #${id}`)
    const next={...old,...patch}
    this.db.prepare('UPDATE tasks SET title=?,title_key=?,status=?,due_at=?,remind_at=?,reason=?,priority=?,updated_at=?,revision=revision+1 WHERE id=?').run(next.title,normalizeTitle(next.title),next.status,next.due_at,next.remind_at,next.reason,next.priority,now,id)
    this.db.prepare("UPDATE outbox SET state='superseded' WHERE task_id=? AND state IN ('pending','sending')").run(id)
    this.audit('task.update',{id,patch})
    return this.task(id)
  }
  memory(body,kind='explicit',sourceId=null) {
    const exists=this.db.prepare('SELECT id FROM memories WHERE active=1 AND body=?').get(body)
    if(exists) return exists.id
    return Number(this.db.prepare('INSERT INTO memories(kind,body,source_id,created_at) VALUES (?,?,?,?)').run(kind,body,sourceId,Date.now()).lastInsertRowid)
  }
  memories() { return this.db.prepare('SELECT * FROM memories WHERE active=1 ORDER BY id DESC LIMIT 100').all() }
  forget(id) { const r=this.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(id); this.audit('memory.forget',{id}); return r.changes }
  enqueue(key,kind,body,{taskId=null,revision=null,now=Date.now()}={}) { return this.db.prepare('INSERT OR IGNORE INTO outbox(unique_key,kind,body,task_id,revision,created_at) VALUES (?,?,?,?,?,?)').run(key,kind,body,taskId,revision,now).changes }
  checkpoint() { return this.db.prepare('SELECT * FROM checkpoints ORDER BY id DESC LIMIT 1').get() }
  history(after=0,limit=30) { return this.db.prepare("SELECT id,text,result,received_at FROM inbox WHERE id>? AND state='done' ORDER BY id DESC LIMIT ?").all(after,limit).reverse() }
  search(q) { return this.db.prepare('SELECT id,text,result,received_at FROM inbox WHERE instr(lower(text),lower(?))>0 ORDER BY id DESC LIMIT 10').all(q) }
  snapshot() {
    return { tasks:this.tasks(true),memories:this.memories(),checkpoint:this.checkpoint() ?? null,
      inbox:this.db.prepare('SELECT id,text,state,received_at,error,result FROM inbox ORDER BY id DESC LIMIT 30').all().map(row=>{const c=this.inputContext(row.id);return {...row,readable_text:c?.text,assets:c?.assets??[]}}),
      toolRuns:this.db.prepare('SELECT inbox_id,name,args,state,result,created_at,finished_at FROM tool_runs ORDER BY created_at DESC LIMIT 20').all(),
      outbox:this.db.prepare('SELECT id,kind,state,attempts,error,created_at,sent_at FROM outbox ORDER BY id DESC LIMIT 30').all(),
      audit:this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 20').all() }
  }
}
