import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../src/store.mjs'
import {SocialStore} from '../src/social-store.mjs'
import {SocialMaintenance} from '../src/social-maintenance.mjs'
function fixture(t){const root=mkdtempSync(join(tmpdir(),'social-memory-')),store=new Store(join(root,'db')),data=new SocialStore(store),maintenance=new SocialMaintenance(data);const target=data.discover({platform:'qq',account:'10001',kind:'private',peer:'123'});data.approve(target.handle,true);const view=data.open(target.handle);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})});return {store,data,maintenance,target,view}}
test('idle memory review advances only its successful range and does not reschedule unchanged history',t=>{
 const {data,maintenance,target,view}=fixture(t),now=Date.parse('2026-10-19T15:00:00+08:00')
 const first=data.ingest({target:target.handle,sender:'123',externalId:'one',text:'直说吧',receivedAt:now-130000})
 assert.equal(maintenance.next(now),null);data.markRead(view.id,[first.id])
 const job=maintenance.next(now);assert.equal(job.kind,'idle');assert.equal(job.through,first.id)
 maintenance.finish(maintenance.claim(job,'request-one',now),{ok:true},now)
 assert.equal(maintenance.next(now+3600000),null)
 const second=data.ingest({target:target.handle,sender:'123',externalId:'two',text:'继续',receivedAt:now+1000});data.markRead(view.id,[second.id])
 assert.equal(maintenance.next(now+200000),null)
 const next=maintenance.next(now+3600000);assert.equal(next.after,first.id);assert.equal(next.through,second.id)
})
test('failed reviews do not loop and night selection uses Shanghai local time',t=>{
 const {data,maintenance,target,view}=fixture(t),now=Date.parse('2026-10-20T02:30:00+08:00')
 const event=data.ingest({target:target.handle,sender:'123',externalId:'one',text:'睡了',receivedAt:now-300000});data.markRead(view.id,[event.id])
 const job=maintenance.next(now);assert.equal(job.kind,'night');assert.equal(job.day,'2026-10-20')
 maintenance.finish(maintenance.claim(job,'night-one',now),{ok:false,error:'cancelled'},now)
 assert.equal(maintenance.next(now+10000),null)
 assert.equal(maintenance.status().cursors.length,0)
})
test('communication learning does not promote one utterance or a forwarded identity into a stable habit',t=>{
 const {data,target,view}=fixture(t),first=data.ingest({target:target.handle,sender:'123',externalId:'one',text:'直说吧'})
 const value={kind:'communication',body:'偏好直接表达',sources:[{id:first.id,quote:'直说吧'}],confidence:'observed'}
 assert.throws(()=>data.remember(view.id,value),/两条/)
 assert.ok(data.remember(view.id,{...value,confidence:'hypothesis'}).id)
 const second=data.ingest({target:target.handle,sender:'123',externalId:'two',text:'别绕弯子'})
 assert.ok(data.remember(view.id,{...value,body:'反复要求直接表达',sources:[...value.sources,{id:second.id,quote:'别绕弯子'}]}).id)
 const forwarded=data.ingest({target:target.handle,sender:'123',externalId:'three',text:'直说吧',segments:[{type:'forward',data:{id:'forward'}}]})
 assert.throws(()=>data.remember(view.id,{...value,confidence:'self_report',sources:[{id:forwarded.id,quote:'直说吧'}]}),/直接原文/)
})


test('operator retry reuses a failed range with a new request and advances the cursor on success',t=>{
 const {data,maintenance,target,view}=fixture(t),now=Date.parse('2026-10-19T15:00:00+08:00')
 const message=data.ingest({target:target.handle,sender:'123',externalId:'one',text:'记录一下',receivedAt:now-300000});data.markRead(view.id,[message.id])
 const job=maintenance.claim(maintenance.next(now),'first',now);maintenance.finish(job,{ok:false,error:'timeout'},now)
 assert.equal(maintenance.next(now+1000),null);maintenance.retry(job.id)
 const retry=maintenance.claim(maintenance.next(now+1000),'second',now+1000);assert.equal(retry.id,job.id)
 maintenance.finish(retry,{ok:true},now+2000);assert.equal(maintenance.status().cursors[0].through_id,message.id)
})

test('a long backlog is consolidated in bounded pages instead of one oversized turn',t=>{
 const {data,maintenance,target}=fixture(t),now=Date.parse('2026-10-19T15:00:00+08:00'),ids=[]
 for(let i=0;i<300;i++)ids.push(data.ingest({target:target.handle,sender:'123',externalId:'m'+i,text:'消息'+i,receivedAt:now-300000}).id)
 data.db.prepare('UPDATE yoyo_events SET read_at=?').run(now-200000)
 const first=maintenance.plan(now)
 assert.equal(first.job.kind,'idle')
 assert.equal(first.job.pageSize,120)
 assert.equal(first.job.through,ids[119],'one review covers 120 events')
 maintenance.finish(maintenance.claim(first.job,'page-1',now),{ok:true},now)
 // Each further run continues from the cursor instead of re-reading the backlog.
 maintenance.config.cooldownMs=0
 const second=maintenance.plan(now)
 assert.equal(second.job.after,ids[119])
 assert.equal(second.job.through,ids[239])
 maintenance.finish(maintenance.claim(second.job,'page-2',now),{ok:true},now)
 const third=maintenance.plan(now)
 assert.equal(third.job.after,ids[239])
 assert.equal(third.job.through,ids[299],'the last page stops at the newest event')
 assert.throws(()=>new SocialMaintenance(data,{pageEvents:0}),/分页条数/)
})

test('a quiet night is explained instead of calling the model',t=>{
 const {data,maintenance,target}=fixture(t),now=Date.parse('2026-10-20T03:05:00+08:00')
 assert.deepEqual(maintenance.plan(now),{job:null,reason:'没有新的可整理原文'})
 const event=data.ingest({target:target.handle,sender:'123',externalId:'one',text:'睡了',receivedAt:now-300000})
 data.db.prepare('UPDATE yoyo_events SET read_at=? WHERE id=?').run(now-200000,event.id)
 const night=maintenance.plan(now)
 assert.equal(night.job.kind,'night')
 assert.equal(night.job.through,event.id)
 assert.equal(night.reason,null)
 maintenance.finish(maintenance.claim(night.job,'night-1',now),{ok:true},now)
 // The same night is not re-consolidated: later material in the window is ordinary idle work.
 const second=data.ingest({target:target.handle,sender:'123',externalId:'two',text:'还没睡',receivedAt:now+100000})
 data.db.prepare('UPDATE yoyo_events SET read_at=? WHERE id=?').run(now+150000,second.id)
 maintenance.config.cooldownMs=0
 const later=maintenance.plan(now+400000)
 assert.equal(later.job.kind,'idle','after the nightly run the rest of the night is ordinary consolidation')
 assert.match(maintenance.status().cursors[0].last_night,/2026-10-20/)
 // Unread material is not consolidated, and the skip says why rather than guessing.
 data.db.prepare('UPDATE yoyo_events SET read_at=NULL').run()
 const unread=maintenance.plan(now+500000)
 assert.equal(unread.job,null)
 assert.equal(unread.reason,'没有新的可整理原文')
})
