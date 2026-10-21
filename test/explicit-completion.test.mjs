import test from 'node:test'
import assert from 'node:assert/strict'
import { completionGuard } from '../src/explicit-completion.mjs'

test('native stop requires an explicit decision and bounds unproductive continuation',()=>{
  let decided=false;const messages=[],agent={steer:m=>messages.push(m)}
  const guard=completionGuard({decided:()=>decided,reminder:'continue or conclude'})
  guard({agent,turn:1});guard({agent,turn:1})
  assert.equal(messages.length,2)
  assert.throws(()=>guard({agent,turn:1}),/尚未明确/)
  decided=true;guard({agent,turn:1})
  assert.equal(messages.length,2)
  decided=false;guard({agent,turn:2})
  assert.equal(messages.length,3)
})
