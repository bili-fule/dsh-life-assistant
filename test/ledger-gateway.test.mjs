import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { forwardLedger } from '../deploy/ledger-gateway.mjs'
test('public HTTPS gateway only forwards ledger routes, drops admin auth and other site cookies',async t=>{
 const seen=[],server=createServer((req,res)=>void forwardLedger(req,res,{fetchImpl:async(url,init)=>{seen.push({url,init});return new Response('{"ok":true}',{headers:{'set-cookie':'ledger_session='+ 'a'.repeat(64)+'; HttpOnly; Secure; SameSite=Strict; Path=/api/ledger/'}})}}))
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const base='http://127.0.0.1:'+server.address().port
 for(const path of ['/api/state','/api/asset','/api/ledger/settings','/api/ledger/amend','/api/ledger/../state'])assert.equal((await fetch(base+path)).status,404)
 const response=await fetch(base+'/api/ledger/details?month=2026-10',{headers:{authorization:'Bearer SECRET_ADMIN',cookie:'other=PRIVATE; ledger_session='+ 'b'.repeat(64)}})
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store, private');assert.match(response.headers.get('set-cookie'),/Secure/)
 assert.equal(seen.length,1);assert.equal(seen[0].url,'http://127.0.0.1:3180/api/ledger/details?month=2026-10')
 assert.deepEqual(seen[0].init.headers,{'content-type':'application/json',cookie:'ledger_session='+ 'b'.repeat(64)})
 assert.equal((await fetch(base+'/api/ledger/login',{method:'POST',headers:{origin:'https://attacker.test','content-type':'application/json'},body:'{}'})).status,403)
 assert.equal((await fetch(base+'/api/ledger/login',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(5000)})).status,413)
 assert.equal(seen.length,1)
})
