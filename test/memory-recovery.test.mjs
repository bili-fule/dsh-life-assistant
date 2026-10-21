import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { MemoryLayer } from '../src/memory-layer.mjs'
import { SocialMaintenance } from '../src/social-maintenance.mjs'

// The acceptance question behind these tests is not "does the table exist", but
// "after a restart or a revocation, does the layer still behave the same way".
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'yoyo-recovery-')),file=join(dir,'data.sqlite')
  const boot=()=>{
    const store=new Store(file),data=new SocialStore(store)
    return {store,data,memory:new MemoryLayer(data),close(){store.close()}}
  }
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const target=data=>{const found=data.discover({platform:'qq',account:'10001',kind:'private',peer:'123'});return data.approve(found.handle,true)}
  return {file,boot,target}
}

test('a restart keeps memory, consumed triggers and tombstones exactly as they were',t=>{
  const {boot,target}=fixture(t)
  const first=boot(),handle=target(first.data),view=first.data.open(handle.handle)
  const said=first.data.ingest({target:handle.handle,sender:'123',externalId:'r1',text:'我确实更喜欢语音'}).id
  const later=first.data.ingest({target:handle.handle,sender:'123',externalId:'r2',text:'结果出来了'}).id
  first.memory.propose(view.id,{kind:'episode',title:'聊到沟通方式',role:'participant',what:'他更喜欢语音',evidence:{messages:[said]}})
  const kept=first.memory.propose(view.id,{kind:'claim',claimType:'preference',statement:'对方更习惯语音',evidence:{messages:[said]},confidence:'told'})
  const dropped=first.memory.propose(view.id,{kind:'claim',claimType:'fact',statement:'他住在城东',evidence:{messages:[later]},confidence:'told'})
  first.memory.retract(view.id,{kind:'claim',id:dropped.id,mode:'forget',reason:'他要求忘掉住址'})
  first.memory.recall(view.id,{query:'语音',used:[{kind:'claim',id:kept.id}]})
  // A window trigger is delivered once before the restart.
  const intent=first.memory.intent(view.id,{statement:'结果出来后再聊',kind:'commitment',trigger:'window',about:handle.handle,
    doneWhen:'把结果发给他',evidence:{messages:[said]}})
  first.data.ingest({target:handle.handle,sender:'123',externalId:'r3',text:'出来了吗'})
  const due=first.memory.dueIntent(Date.now())
  assert.equal(due.id,intent.id)
  first.memory.consumeIntent(due.id,due.consumedRef)
  const before=first.memory.summary(first.data.view(view.id))
  first.close()

  const second=boot(),again=second.data.open(handle.handle)
  // Same records, same counts, same confidence class after the restart.
  const recalled=second.memory.recall(again.id,{query:'语音'})
  assert.equal(recalled.results.length,2,'the episode and the kept claim come back')
  assert.equal(recalled.results.find(row=>row.kind==='claim').confidence,'told')
  const after=second.memory.summary(second.data.view(again.id))
  assert.equal(after.episodes,before.episodes)
  assert.equal(after.claims,before.claims)
  assert.equal(after.intents,before.intents)
  assert.equal(after.wakes.delivered,1)
  // The delivered wake is still unsettled: the intention was never closed.
  assert.equal(after.wakes.open,1)
  assert.equal(after.wakes.done+after.wakes.dropped+after.wakes.ignored,0)
  // The forgotten claim stays gone and the tombstone still blocks re-derivation.
  assert.equal(second.memory.recall(again.id,{query:'城东'}).results.length,0)
  assert.throws(()=>second.memory.propose(again.id,{kind:'claim',claimType:'fact',statement:'他住在城东',evidence:{messages:[later]},confidence:'told'}),/忘记/)
  assert.throws(()=>second.memory.inspect(again.id,{kind:'claim',id:dropped.id}),/撤回/)
  // The consumed window trigger does not fire again for the same event.
  assert.equal(second.memory.dueIntent(Date.now()),null)
  second.data.ingest({target:handle.handle,sender:'123',externalId:'r4',text:'看到了吗'})
  const rearmed=second.memory.dueIntent(Date.now())
  assert.equal(rearmed.id,intent.id,'a genuinely new message wakes it again')
  assert.equal(second.memory.intents(second.data.view(again.id))[0].wakes.delivered,1)
  second.close()
})

test('revoking a window invalidates its view and keeps the memory for a new one',t=>{
  const {boot,target}=fixture(t)
  const {data,memory,close}=boot(),handle=target(data),view=data.open(handle.handle)
  const said=data.ingest({target:handle.handle,sender:'123',externalId:'v1',text:'只跟你说的事'}).id
  memory.propose(view.id,{kind:'episode',title:'一次私聊',role:'participant',what:'说了私事',evidence:{messages:[said]}})
  const intent=memory.intent(view.id,{statement:'过两天问问他',kind:'intention',trigger:'time',dueAt:Date.now()+1000,evidence:{messages:[said]}})
  // Revocation invalidates the view itself, not just the reminder.
  data.approve(handle.handle,false)
  assert.throws(()=>memory.recall(view.id,{query:'私事'}),/授权|范围/)
  assert.equal(memory.dueIntent(Date.now()+2000),null,'a revoked window cannot surface a reminder')
  // Re-approving does not resurrect the old view id: the version moved on.
  data.approve(handle.handle,true)
  assert.throws(()=>memory.recall(view.id,{query:'私事'}),/授权|范围/)
  // A freshly opened view sees the same memory: revocation hides, it never deletes.
  const reopened=data.open(handle.handle)
  assert.equal(memory.recall(reopened.id,{query:'私事'}).results.length,1)
  assert.equal(memory.intents(data.view(reopened.id)).find(row=>row.id===intent.id).state,'open')
  close()
})

test('an interrupted maintenance run is not repeated silently after a restart',t=>{
  const {boot,target}=fixture(t)
  const first=boot(),handle=target(first.data),view=first.data.open(handle.handle)
  const said=first.data.ingest({target:handle.handle,sender:'123',externalId:'m1',text:'聊了几句'}).id
  first.data.markRead(view.id,[said])
  const settings={idleMs:0,cooldownMs:0}
  const job=new SocialMaintenance(first.data,settings).next(Date.now())
  assert.equal(job.kind,'idle')
  const claimed=new SocialMaintenance(first.data,settings).claim(job,'request-1')
  // The process dies mid-run: the row stays 'running' and no cursor is written.
  first.close()

  const second=boot(),reopened=new SocialMaintenance(second.data,settings)
  const row=second.data.db.prepare('SELECT * FROM yoyo_memory_jobs WHERE id=?').get(claimed.id)
  assert.equal(row.state,'interrupted')
  assert.match(row.error,/重启/)
  assert.equal(second.data.db.prepare('SELECT * FROM yoyo_memory_cursors WHERE target=?').get(handle.handle),undefined)
  // The same range is not handed out again on its own: no quiet repeat.
  assert.equal(reopened.next(Date.now()),null)
  // An explicit retry re-runs exactly that range, and success advances the cursor.
  assert.equal(reopened.retry(claimed.id).scheduled,true)
  const retried=reopened.next(Date.now())
  assert.equal(retried.retryId,claimed.id)
  assert.equal(retried.through,claimed.through)
  reopened.finish({...retried,id:claimed.id},{ok:true})
  assert.equal(second.data.db.prepare('SELECT through_id FROM yoyo_memory_cursors WHERE target=?').get(handle.handle).through_id,claimed.through)
  second.close()
})
