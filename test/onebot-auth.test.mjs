import test from 'node:test'
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {authorizedEvent} from '../deploy/onebot-auth.mjs'
test('SnowLuma HMAC event authentication rejects altered payloads and unsigned requests',()=>{
 const token='test-only-event-secret-1234567890',body=Buffer.from('{"post_type":"message"}')
 const signature='sha1='+createHmac('sha1',token).update(body).digest('hex')
 assert.equal(authorizedEvent({'x-signature':signature},body,token),true)
 assert.equal(authorizedEvent({'x-signature':signature},Buffer.from('{}'),token),false)
 assert.equal(authorizedEvent({},body,token),false)
 assert.equal(authorizedEvent({authorization:'Bearer '+token},body,token),true)
 assert.equal(authorizedEvent({authorization:'Bearer wrong'},body,token),false)
})
