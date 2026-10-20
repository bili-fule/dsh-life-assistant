// Operator CLI for WeChat Pay XLSX or Alipay CSV bills.
// Keep the database and original bills outside the plugin repo.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.mjs'
import { Ledger } from '../src/ledger.mjs'
const [database,bill]=process.argv.slice(2)
if(!database||!bill)throw Error('Usage: node deploy/import-wechat-bill.mjs /private/assistant.sqlite /private/bill.xlsx|bill.csv')
const parsed=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',[fileURLToPath(new URL('../src/bill.py',import.meta.url)),bill],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,env:{...process.env,PYTHONUTF8:'1'}}))
const store=new Store(database)
try{console.log(JSON.stringify(new Ledger(store).importBill(parsed)))}finally{store.close()}
