import test from 'node:test'
import assert from 'node:assert/strict'
import {qqMediaHost,imageExtension} from '../src/qq-media.mjs'
test('QQ CDN allowlist admits actual nt.qq.com.cn images but not suffix lookalikes',()=>{
 assert.equal(qqMediaHost('multimedia.nt.qq.com.cn'),true);assert.equal(qqMediaHost('gchat.qpic.cn'),true)
 for(const host of ['qq.com.cn.evil.com','evilqq.com.cn','localhost','169.254.169.254'])assert.equal(qqMediaHost(host),false)
})
test('image content is detected independently of CDN content-type and rejects HTML',()=>{
 assert.equal(imageExtension(Buffer.from('GIF89aimage')),'gif');assert.equal(imageExtension(Buffer.from([255,216,255])),'jpg')
 assert.throws(()=>imageExtension(Buffer.from('<html>error</html>')),/图片格式/)
})
