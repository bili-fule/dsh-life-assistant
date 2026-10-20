import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.mjs'
import { Ledger,cents } from '../src/ledger.mjs'
import { Runtime } from '../src/runtime.mjs'

function python(){for(const cmd of ['python3','python'])try{execFileSync(cmd,['-c','print(1)'],{stdio:'ignore'});return cmd}catch{}return null}

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

test('batch labeling preserves money, rejects stale/uncertain labels atomically and audits refund links',t=>{
 const {ledger,store}=fixture(t)
 const a=ledger.insert(entry({category:'未分类',amount:'20'}),'a',{}).id
 const b=ledger.insert(entry({category:'未分类',kind:'refund',amount:'5'}),'b',{}).id
 const before=ledger.summary()
 const tag=(id,category='餐饮',revision=1)=>({id,revision,category,confidence:0.95,reason:'商品明确为午饭'})
 assert.throws(()=>ledger.classify({items:[tag(a),{...tag(b),confidence:0.2}]}),/置信度/)
 assert.equal(ledger.list().entries.find(e=>e.id===a).revision,1)
 ledger.classify({items:[tag(a),{...tag(b),refundOf:a}]})
 assert.deepEqual(ledger.summary(),before)
 assert.equal(ledger.categories()[0].cents,1500)
 assert.throws(()=>ledger.classify({items:[tag(a)]}),/版本/)
 assert.equal(ledger.pending(),0)
 assert.equal(store.db.prepare('SELECT count(*) n FROM ledger_changes').get().n,4)
 store.set('ledger_public_enabled',true)
 assert.equal(JSON.stringify(ledger.publicSummary()).includes('午饭'),false)
 ledger.insert(entry({category:'PRIVATE_CUSTOM_CATEGORY'}),'c',{})
 assert.equal(JSON.stringify(ledger.publicSummary()).includes('PRIVATE'),false)
 assert.equal(ledger.list({pending:true}).entries.length,0)
})

test('category direction errors identify the row, and amending an expense invalidates refund evidence',t=>{
 const {ledger}=fixture(t),a=ledger.insert(entry({amount:'20'}),'a',{}).id,b=ledger.insert(entry({kind:'refund',amount:'5'}),'b',{}).id,c=ledger.insert(entry({kind:'income'}),'c',{}).id
 assert.throws(()=>ledger.classify({items:[{id:c,revision:1,category:'购物',confidence:0.9,reason:'wrong direction'}]}),/类型为 income/)
 ledger.classify({items:[{id:a,revision:1,category:'餐饮',confidence:0.9,reason:'午餐'},{id:b,revision:1,category:'餐饮',confidence:0.9,reason:'原订单退款',refundOf:a}]})
 assert.throws(()=>ledger.classify({items:[{id:a,revision:2,category:'购物',confidence:0.9,reason:'修正'}]}),/关联退款/)
 ledger.amend({id:a,revision:2,patch:{amount:'19'},reason:'用户更正'})
 const refund=ledger.list().entries.find(e=>e.id===b)
 assert.equal(refund.category,'待确认');assert.equal(refund.refund_of,null);assert.equal(refund.revision,3)
})

test('Alipay import keeps settled rows, records skipped rows and deduplicates by order id',t=>{
 const {ledger}=fixture(t),rows=[
  entry({externalId:'ali-expense',amount:'10.00',category:'未分类'}),
  entry({externalId:'ali-income',kind:'income',amount:'100.00',category:'未分类'}),
  entry({externalId:'ali-refund',kind:'refund',amount:'10.00',category:'退款'}),
  entry({externalId:'ali-transfer',kind:'transfer',amount:'20.00',category:'账户划转'})]
 const skipped={count:2,cents:1200,rows:[{row:3,day:'2026-10-02',status:'交易关闭',direction:'支出',amount:'5.00',category:'日用百货'},{row:5,day:'2026-10-04',status:'等待对方确认收货',direction:'收入',amount:'7.00',category:'收入'}]}
 const control={total:6,settled:{income:{count:2,cents:11000},expense:{count:1,cents:1000},transfer:{count:1,cents:2000}},footer:{income:{count:2,cents:10000},expense:{count:3,cents:3000},transfer:{count:2,cents:3000}},skipped}
 const bill={format:'alipay-csv',digest:'e'.repeat(64),label:'alipay.csv',rows,control}
 assert.equal(ledger.importBill(bill).skipped,2)
 assert.equal(ledger.importBill(bill).duplicateFile,true)
 assert.equal(ledger.summary()[0].income,10000);assert.equal(ledger.summary()[0].refund,1000)
 assert.equal(ledger.summary()[0].expense,1000);assert.equal(ledger.summary()[0].transfer,2000)
 assert.equal(ledger.list().entries[0].source.kind,'alipay')
 assert.throws(()=>ledger.importBill({...bill,digest:'f'.repeat(64),control:{...control,total:7}}),/页头/)
 assert.throws(()=>ledger.importBill({...bill,digest:'1'.repeat(64),control:{...control,skipped:{...skipped,cents:1}}}),/核对/)
 assert.equal(ledger.list().entries.length,4)
})

test('bill.py parses Alipay CSV into settled rows plus an explicit skipped list',t=>{
 const interpreter=python()
 if(!interpreter)return t.skip('python is not available')
 const root=mkdtempSync(join(tmpdir(),'alipay-bill-')),file=join(root,'alipay.csv')
 t.after(()=>rmSync(root,{recursive:true,force:true}))
 writeFileSync(file,'\uFEFF'+[
  '------------------------------------------------------------------------------------',
  '导出信息：','姓名：测试','支付宝账户：13800000000',
  '起始时间：[2026-10-01 00:00:00]    终止时间：[2026-10-31 23:59:59]',
  '导出交易类型：[全部]','导出时间：[2026-11-01 08:00:00]',
  '共6笔记录','收入：2笔 100.00元','支出：3笔 30.00元','不计收支：2笔 30.00元','',
  '特别提示：','1.本回单内容可表明支付宝受理了相应支付交易申请。','',
  '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
  '2026-10-01 12:00:00,餐饮美食,测试餐厅,/,午饭,支出,10.00,余额,交易成功,T1,M1,,',
  '2026-10-02 12:00:00,日用百货,测试商店,/,关闭订单,支出,5.00,余额,交易关闭,T2,M2,,',
  '2026-10-03 12:00:00,收入,测试买家,/,收款,收入,100.00,余额,交易成功,T3,M3,,',
  '2026-10-04 12:00:00,收入,测试买家,/,待确认收款,收入,7.00,余额,等待对方确认收货,T4,M4,,',
  '2026-10-05 12:00:00,退款,测试卖家,/,退款,不计收支,10.00,余额,退款成功,T5,M5,,',
  '2026-10-06 12:00:00,账户存取,余额宝,/,转入,不计收支,20.00,余额,交易成功,T6,M6,,'].join('\r\n'),'utf8')
 const parsed=JSON.parse(execFileSync(interpreter,[fileURLToPath(new URL('../src/bill.py',import.meta.url)),file],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}}))
 assert.equal(parsed.format,'alipay-csv');assert.equal(parsed.rows.length,4)
 assert.deepEqual(parsed.rows.map(r=>r.kind),['expense','income','refund','transfer'])
 assert.equal(parsed.control.total,6);assert.equal(parsed.control.skipped.count,2)
 assert.deepEqual(parsed.control.settled,{expense:{count:1,cents:1000},income:{count:2,cents:11000},transfer:{count:1,cents:2000}})
 const {ledger}=fixture(t);ledger.importBill(parsed)
 assert.equal(ledger.summary()[0].income,10000);assert.equal(ledger.summary()[0].refund,1000)
 assert.equal(ledger.summary()[0].expense,1000);assert.equal(ledger.summary()[0].transfer,2000)
})
