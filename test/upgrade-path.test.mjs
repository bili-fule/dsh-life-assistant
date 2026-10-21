import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { MemoryLayer } from '../src/memory-layer.mjs'

// Production runs 0.25.0 while this checkout adds tables and columns. An upgrade
// path is only safe if opening the newer code on the older database is additive:
// nothing is dropped, nothing is rewritten, and the new features start empty.
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'yoyo-upgrade-')),file=join(dir,'data.sqlite')
  const open=()=>{const store=new Store(file),data=new SocialStore(store),memory=new MemoryLayer(data),team=new TeamStore(data);return {store,data,memory,team}}
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  return {file,open}
}

test('opening newer code on an older database only adds what is missing',t=>{
  const {open}=fixture(t)
  const before=open(),found=before.data.discover({platform:'qq',account:'10001',kind:'private',peer:'123'})
  before.data.approve(found.handle,true)
  const view=before.data.open(found.handle)
  const said=before.data.ingest({target:found.handle,sender:'123',externalId:'old-1',text:'我更喜欢语音'}).id
  before.memory.propose(view.id,{kind:'claim',claimType:'preference',statement:'对方更习惯语音',evidence:{messages:[said]},confidence:'told'})
  before.team.create({key:'old-task',role:'chat',goal:'聊天',viewId:view.id,expiresAt:Date.now()+600000})
  before.team.claim(before.team.db.prepare('SELECT id FROM yoyo_team_tasks').get().id,'worker-old')
  before.team.recordStep('worker-old',20)
  before.team.recordTokens('worker-old',300)
  const taskId=before.team.db.prepare('SELECT id FROM yoyo_team_tasks').get().id
  assert.equal(before.team.usage(taskId).tokensReported,true)
  // Rewind the parts that 0.25.0 did not have, so the reopen has real work to do.
  before.data.db.exec('DROP TABLE yoyo_team_memory_packs')
  before.data.db.exec('DROP TABLE yoyo_team_memory_candidates')
  before.data.db.exec('DROP TABLE yoyo_concern_wakes')
  before.data.db.exec('DROP TABLE yoyo_memory_wakes')
  before.data.db.exec('ALTER TABLE yoyo_team_usage DROP COLUMN tokens_reported')
  assert.throws(()=>before.team.usage(taskId),/tokens_reported/,'the rewound database really looks older')
  before.store.close()

  const after=open()
  // Everything that existed is still there, and nothing was reset.
  assert.equal(after.team.inspect(taskId,view.id).state,'running')
  const usage=after.team.usage(taskId)
  assert.equal(usage.steps,1)
  assert.equal(usage.tokens,300)
  assert.equal(usage.tokensReported,true,'a pre-existing positive count came from a real report')
  const recalled=after.memory.recall(view.id,{query:'语音'})
  assert.equal(recalled.results.length,1)
  assert.equal(recalled.results[0].confidence,'told')
  assert.equal(after.data.target(found.handle,{approved:true}).approved,1)
  // The new surfaces exist and are empty rather than half-created.
  for(const table of ['yoyo_team_memory_packs','yoyo_team_memory_candidates','yoyo_concern_wakes','yoyo_memory_wakes'])
    assert.equal(after.data.db.prepare('SELECT count(*) n FROM '+table).get().n,0,'new table starts empty: '+table)
  assert.deepEqual(after.memory.wakeStats(after.data.view(view.id)),{delivered:0,done:0,dropped:0,ignored:0,open:0})
  after.store.close()
})

test('opening the same database twice in a row is a no-op',t=>{
  const {open}=fixture(t)
  const first=open(),found=first.data.discover({platform:'qq',account:'10001',kind:'private',peer:'9'})
  first.data.approve(found.handle,true)
  const view=first.data.open(found.handle)
  const columns=()=>first.data.db.prepare('PRAGMA table_info(yoyo_team_usage)').all().map(column=>column.name).sort()
  const tables=()=>first.data.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name)
  const before={columns:columns(),tables:tables()}
  // A second construction over the same open connection must not alter anything.
  new MemoryLayer(first.data);new TeamStore(first.data)
  assert.deepEqual(columns(),before.columns)
  assert.deepEqual(tables(),before.tables)
  assert.equal(first.data.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  assert.ok(view.id)
  first.store.close()
  const second=open()
  assert.deepEqual(second.data.db.prepare('PRAGMA table_info(yoyo_team_usage)').all().map(column=>column.name).sort(),before.columns)
  assert.equal(second.data.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  second.store.close()
})
