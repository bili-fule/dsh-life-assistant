import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { Ledger,cents } from '../src/ledger.mjs'
import { Runtime } from '../src/runtime.mjs'

function fixture(t){const root=mkdtempSync(join(tmpdir(),'ledger-')),store=new Store(join(root,'test.sqlite')),ledger=new Ledger(store);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})});return {store,ledger}}
const entry=(overrides={})=>({day:'2026-10-20',kind:'expense',amount:'12.30',category:'餐饮',counterparty:'PRIVATE_MERCHANT',description:'PRIVATE_PRODUCT',account:'PRIVATE_CARD',...overrides})
test('money uses exact cents, refuses rounding and validates calendar dates',t=>{
 const {ledger}=fixture(t)
 assert.equal(cents('0.10'),10);assert.equal(cents('100.01'),10001)
 for(const n of ['1.001','-1','1e3','NaN','0','Infinity'])assert.throws(()=>cents(n))
 assert.throws(()=>ledger.insert(entry({day:'2026-02-30'}),'bad',{}))
})
test('WeChat import reconciles original directions, deduplicates overlapping files and rolls back conflicts',t=>{
 const {ledger}=fixture(t),rows=[entry({externalId:'paid',amount:'20'}),entry({externalId:'refund',kind:'refund',amount:'5'}),entry({externalId:'salary',kind:'income',amount:'100'}),entry({externalId:'move',kind:'transfer',amount:'10'})]
 const control={income:{count:2,cents:10500},expense:{count:1,cents:2000},transfer:{count:1,cents:1000}},bill={digest:'a'.repeat(64),label:'bill',rows,control}
 assert.equal(ledger.importBill(bill).inserted,4)
 assert.equal(ledger.importBill(bill).duplicateFile,true)
 assert.equal(ledger.importBill({...bill,digest:'b'.repeat(64)}).duplicates,4)
 assert.equal(ledger.summary()[0].income,10000);assert.equal(ledger.summary()[0].refund,500)
 assert.equal(ledger.summary()[0].netExpense,1500);assert.equal(ledger.summary()[0].balance,8500)
 assert.throws(()=>ledger.importBill({...bill,digest:'c'.repeat(64),rows:[...rows,entry({externalId:'new'})]}),/汇总/)
 assert.equal(ledger.list().entries.length,4)
 assert.throws(()=>ledger.importBill({...bill,digest:'d'.repeat(64),rows:[entry({externalId:'paid',amount:'21'})],control:{income:{count:0,cents:0},expense:{count:1,cents:2100},transfer:{count:0,cents:0}}}),/冲突/)
})
test('manual ledger entries require direct owner evidence and repeat imports cannot double count them',t=>{
 const {store,ledger}=fixture(t);store.set('owner','owner');store.ingest('message-1','owner','今天午饭花了12.30元')
 const id=store.db.prepare('SELECT id FROM inbox').get().id
 const saved=ledger.record({...entry(),sourceId:id,quote:'午饭花了12.30元'})
 assert.equal(ledger.record({...entry(),sourceId:id,quote:'午饭花了12.30元'}).duplicate,true)
 assert.throws(()=>ledger.record({...entry({amount:'120'}),sourceId:id,quote:'午饭花了12.30元'}),/金额/)
 assert.throws(()=>ledger.record({...entry(),sourceId:id,quote:'编造的12.30元'}),/证据/)
 ledger.amend({id:saved.id,revision:1,patch:{amount:'13.30'},reason:'用户更正'})
 assert.throws(()=>ledger.amend({id:saved.id,revision:1,patch:{voided:true},reason:'重复'}),/版本/)
 ledger.amend({id:saved.id,revision:2,patch:{voided:true},reason:'用户作废'})
 assert.deepEqual(ledger.summary(),[])
 assert.equal(store.db.prepare('SELECT count(*) n FROM ledger_changes').get().n,3)
})
test('public projection includes exact monthly totals, never transaction details',t=>{
 const {ledger,store}=fixture(t);ledger.insert(entry(),'one',{})
 assert.deepEqual(ledger.publicSummary(),{published:false,months:[]})
 store.set('ledger_public_enabled',true)
 const result=ledger.publicSummary(),serialized=JSON.stringify(result)
 for(const secret of ['PRIVATE_','counterparty','account','description','source','count'])assert.equal(serialized.includes(secret),false)
 assert.equal(result.precision,'exact');assert.equal(result.months[0].expense,1230)
 ledger.insert(entry({kind:'refund',amount:'1012.30'}),'refund',{})
 assert.equal(ledger.publicSummary().months[0].expense,-100000)
})
test('login sessions are hashed, expire and are revoked by password reset',t=>{
 const {ledger,store}=fixture(t);ledger.setPassword('a-good-password-123')
 assert.equal(ledger.login('wrong'),null)
 const token=ledger.login('a-good-password-123');assert.equal(ledger.authenticated(token),true)
 assert.equal(store.db.prepare('SELECT hash FROM ledger_sessions').get().hash===token,false)
 ledger.setPassword('another-password-123');assert.equal(ledger.authenticated(token),false)
 const next=ledger.login('another-password-123');ledger.logout(next);assert.equal(ledger.authenticated(next),false)
})
test('HTTP denies anonymous details, enforces cookie auth and CSRF, and limits login attempts',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ledger-http-')),runtime=new Runtime({stateDir:root,port:0,agentDriver:{}})
 runtime.tick=async()=>{};runtime.deliveryTick=async()=>{};runtime.startPolling=()=>{}
 await runtime.start();t.after(async()=>{await runtime.stop();rmSync(root,{recursive:true,force:true})})
 runtime.ledger.setPassword('my-secret-password-123');runtime.ledger.insert(entry(),'secret',{})
 runtime.store.set('ledger_public_enabled',true)
 const base='http://127.0.0.1:'+runtime.server.address().port
 assert.equal((await fetch(base+'/api/ledger/details')).status,401)
 const publicData=await (await fetch(base+'/api/ledger/public?month=2026-10&counterparty=x')).text();assert.equal(publicData.includes('PRIVATE'),false)
 const login=await fetch(base+'/api/ledger/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'my-secret-password-123'})})
 assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/)
 const cookie=login.headers.get('set-cookie').split(';')[0],details=await fetch(base+'/api/ledger/details',{headers:{cookie}})
 assert.equal(details.status,200);assert.match(await details.text(),/PRIVATE_MERCHANT/)
 assert.equal((await fetch(base+'/api/ledger/logout',{method:'POST',headers:{cookie,origin:'https://attacker.test','content-type':'application/json'},body:'{}'})).status,403)
 await fetch(base+'/api/ledger/logout',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})
 assert.equal((await fetch(base+'/api/ledger/details',{headers:{cookie}})).status,401)
 for(let i=0;i<10;i++)await fetch(base+'/api/ledger/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"password":"bad"}'})
 assert.equal((await fetch(base+'/api/ledger/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,429)
})
