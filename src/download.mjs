import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable,Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDecipheriv,createHash } from 'node:crypto'
import { httpURL } from './tools.mjs'

// Receive encrypted media with bounded memory; never buffer a whole archive.
export async function downloadMediaFile(url,path,{limit=128*1024*1024,signal,key,fetchImpl=fetch}={}) {
  const abort=signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000)
  let u=httpURL(url),opened=false
  try {
    for(let i=0;i<6;i++) {
      if(u.protocol!=='https:'||!(u.hostname==='weixin.qq.com'||u.hostname.endsWith('.weixin.qq.com')))throw Error('附件下载地址必须属于微信 HTTPS CDN')
      const r=await fetchImpl(u,{redirect:'manual',signal:abort})
      if([301,302,303,307,308].includes(r.status)){const location=r.headers.get('location');await r.body?.cancel();if(!location)throw Error('重定向缺少地址');u=httpURL(new URL(location,u).href);continue}
      if(!r.ok){await r.body?.cancel();throw Error('下载失败 HTTP '+r.status)}
      if(!r.body)throw Error('附件下载响应没有正文')
      if(Number(r.headers.get('content-length')??0)>limit+16){await r.body?.cancel();throw Error(`文件超出下载大小限制（${Math.floor(limit/1024/1024)} MiB）`)}
      let wireBytes=0,bytes=0;const md5=createHash('md5'),sha=createHash('sha256');let prefix=Buffer.alloc(0)
      const wire=new Transform({transform(chunk,enc,done){wireBytes+=chunk.length;done(wireBytes>limit+16?Error('文件超出下载大小限制'):null,chunk)}})
      const plain=new Transform({transform(chunk,enc,done){bytes+=chunk.length;if(bytes>limit)return done(Error('文件超出下载大小限制'));md5.update(chunk);sha.update(chunk);if(prefix.length<32)prefix=Buffer.concat([prefix,chunk.subarray(0,32-prefix.length)]);done(null,chunk)}})
      const output=createWriteStream(path,{flags:'wx',mode:0o600});output.once('open',()=>{opened=true})
      await pipeline(Readable.fromWeb(r.body),wire,...(key?[createDecipheriv(`aes-${key.length*8}-ecb`,key,null)]:[]),plain,output,{signal:abort})
      return {bytes,md5:md5.digest('hex'),sha256:sha.digest('hex'),prefix}
    }
    throw Error('链接重定向过多')
  }catch(e){if(opened)await unlink(path).catch(()=>{});throw e}
}
