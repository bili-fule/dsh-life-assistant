import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runtime } from '../src/runtime.mjs'

test('independent QQ keeps scheduling while the private worker is blocked and stops cleanly',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-scheduler-'))
  const runtime=new Runtime({stateDir:dir,port:0,agentDriver:{stop(){}}})
  const original=runtime.autonomy
  let release,calls=0
  runtime.tick=()=>new Promise(resolve=>{release=resolve})
  runtime.autonomy={enabled:true,separate:true,async tick(){calls++},async deliver(){},stop(){}}
  t.mock.timers.enable({apis:['setInterval']})
  try{
    await runtime.start()
    assert.ok(runtime.working)
    t.mock.timers.tick(500)
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(calls,1)
    t.mock.timers.tick(500)
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(calls,2)
    release();await runtime.stop()
    t.mock.timers.tick(1000)
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(calls,2)
  }finally{
    release?.()
    if(runtime.running)await runtime.stop()
    original.stop()
    rmSync(dir,{recursive:true,force:true})
  }
})
