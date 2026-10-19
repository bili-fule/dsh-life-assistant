import test from 'node:test'
import assert from 'node:assert/strict'
import { publicAddress,publicFetch } from '../src/public-web.mjs'

test('web access rejects internal, metadata, reserved and embedded addresses',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.1.1','0.0.0.0','224.0.0.1','198.18.1.1','192.0.2.1','203.0.113.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::','not-an-ip'])assert.equal(publicAddress(address),false,address)
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(address),true,address)
})

test('URL validation and all DNS answers are checked before making requests',async()=>{
  for(const url of ['http://127.0.0.1:3180/','file:///etc/passwd','http://user:pass@example.com','https://example.com:9999'])await assert.rejects(publicFetch(url))
  let resolutions=0
  await assert.rejects(publicFetch('https://example.com/',{lookupImpl:async()=>{resolutions++;return [{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]}}),/内网/)
  assert.equal(resolutions,1)
})
