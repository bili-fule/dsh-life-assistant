import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'

// Network destinations are resolved and pinned before connecting. Reject all
// non-global ranges, including IPv4-embedded IPv6 and cloud metadata addresses.
export function publicAddress(address) {
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number)
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113)
  }
  if(isIP(address)!==6)return false
  // Only current global-unicast space; reject mapped, local and transition nets.
  const parts=address.toLowerCase().split(':')
  const first=parseInt(parts[0],16),second=parseInt(parts[1]||'0',16)
  return first>=0x2000&&first<=0x3fff&&first!==0x2002&&!(first===0x2001&&second<0x200)&&!(first===0x2001&&second===0xdb8)&&!(first===0x3fff&&second<0x1000)
}

export async function publicFetch(url,{signal,limit=2*1024*1024,redirects=4,lookupImpl=lookup,allowHost}={}) {
  let current=new URL(url)
  for(let i=0;i<=redirects;i++){
    if(!['https:','http:'].includes(current.protocol)||current.username||current.password||current.port&&!['443','80'].includes(current.port)||current.href.length>4000)throw Error('只允许无凭据的公网 HTTP/HTTPS 链接')
    const hostname=current.hostname.replace(/^\[|\]$/g,'')
    if(allowHost&&!allowHost(hostname))throw Error('附件链接离开允许的媒体域名')
    const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookupImpl(hostname,{all:true,verbatim:true})
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw Error('链接指向内网、保留地址或元数据服务')
    signal?.throwIfAborted()
    const selected=addresses[0]
    const response=await new Promise((resolve,reject)=>{
      const req=(current.protocol==='https:'?httpsRequest:httpRequest)(current,{method:'GET',agent:false,signal,headers:{'user-agent':'yoyo-public-research/1.0','accept':'text/html,text/plain,application/json,image/*','accept-encoding':'identity'},lookup:(_host,_options,callback)=>callback(null,[selected])},res=>resolve(res))
      req.setTimeout(15000,()=>req.destroy(Error('网页读取超时')));req.on('error',reject);req.end()
    })
    if([301,302,303,307,308].includes(response.statusCode)){
      const location=response.headers.location;response.destroy()
      if(!location||i===redirects)throw Error('网页重定向次数过多或缺少地址')
      current=new URL(location,current);continue
    }
    if(response.statusCode<200||response.statusCode>=300){response.destroy();throw Error('网页返回 HTTP '+response.statusCode)}
    if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();throw Error('网页返回未请求的压缩内容')}
    let size=0;const chunks=[]
    for await(const chunk of response){size+=chunk.length;if(size>limit){response.destroy();throw Error('网页超过本次读取大小限制')}chunks.push(chunk)}
    return {url:current.href,type:String(response.headers['content-type']??''),bytes:Buffer.concat(chunks)}
  }
}

export async function readPublicPage(url,options) {
  const result=await publicFetch(url,options)
  if(!/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(result.type))throw Error('此链接不是可直接阅读的网页或文本')
  let text=result.bytes.toString('utf8')
  if(/html/i.test(result.type))text=text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim()
  return {url:result.url,text:text.slice(0,60000),truncated:text.length>60000,untrusted:true}
}
