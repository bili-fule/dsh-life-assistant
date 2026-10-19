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
