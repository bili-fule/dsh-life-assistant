// Dedicated HTTPS origin for the website. Never forward assistant admin auth.
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const origin='https://www.xmfu.cn'
const routes=new Set(['GET /api/ledger/public','GET /api/ledger/session','GET /api/ledger/details','POST /api/ledger/login','POST /api/ledger/logout'])
export async function forwardLedger(req,res,{fetchImpl=fetch,backend='http://127.0.0.1:3180'}={}){
  const url=new URL(req.url,'https://ledger.invalid')
  const reply=(status,error)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error}))}
  if(!routes.has(req.method+' '+url.pathname))return reply(404,'没有这个接口')
  if(req.headers.origin&&req.headers.origin!==origin)return reply(403,'请求来源不匹配')
  const headers={'content-type':'application/json'}
  const cookie=String(req.headers.cookie??'').match(/(?:^|;\s*)ledger_session=([a-f0-9]{64})(?:;|$)/)?.[1]
  if(cookie)headers.cookie='ledger_session='+cookie
  let data
  if(req.method==='POST'){
    if(!String(req.headers['content-type']??'').startsWith('application/json'))return reply(415,'需要 JSON 请求')
    let bytes=0;const parts=[]
    for await(const part of req){bytes+=part.length;if(bytes>4096)return reply(413,'请求过长');parts.push(part)}
    data=Buffer.concat(parts)
  }
  try{
    const upstream=await fetchImpl(backend+url.pathname+url.search,{method:req.method,headers,body:data,redirect:'error',signal:AbortSignal.timeout(20000)})
    const output={'content-type':'application/json; charset=utf-8','cache-control':'no-store, private','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}
    const setCookie=upstream.headers.get('set-cookie');if(setCookie)output['set-cookie']=setCookie
    const body=Buffer.from(await upstream.arrayBuffer());if(body.length>2*1024*1024)return reply(502,'响应过大')
    res.writeHead(upstream.status,output);res.end(body)
  }catch{return reply(502,'账本暂时无法连接')}
}
if(process.argv.includes('--serve')){
  const dir=process.env.CREDENTIALS_DIRECTORY
  if(!dir)throw Error('TLS credentials are required')
  createServer({cert:readFileSync(join(dir,'server.crt')),key:readFileSync(join(dir,'server.key')),minVersion:'TLSv1.2'},(req,res)=>{void forwardLedger(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end()})}).listen(443,'0.0.0.0')
}
