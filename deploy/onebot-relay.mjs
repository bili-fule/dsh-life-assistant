import { createServer,request } from 'node:http'
import { authorizedEvent } from './onebot-auth.mjs'

const token=process.env.SNOWLUMA_EVENT_TOKEN
if(typeof token!=='string'||token.length<24)throw Error('OneBot 上报密钥未配置')
const server=createServer(async(req,res)=>{
  try{
    if(req.method!=='POST'||req.url!=='/onebot/event'){res.writeHead(404);return res.end()}
    const chunks=[];let size=0
    for await(const chunk of req){size+=chunk.length;if(size>1024*1024){res.writeHead(413);res.end();req.destroy();return}chunks.push(chunk)}
    const body=Buffer.concat(chunks)
    if(!authorizedEvent(req.headers,body,token)){res.writeHead(401);return res.end()}
    const upstream=request({host:'127.0.0.1',port:Number(process.env.YOYO_ASSISTANT_PORT??3180),path:'/onebot/event',method:'POST',headers:{'content-type':'application/json','content-length':body.length,authorization:'Bearer '+token,...(req.headers['x-signature']?{'x-signature':req.headers['x-signature']}:{})}},reply=>{
      res.writeHead(reply.statusCode,{'content-type':'application/json'});reply.pipe(res)
    })
    upstream.setTimeout(15000,()=>upstream.destroy(Error('upstream timeout')))
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});upstream.end(body)
  }catch{if(!res.headersSent)res.writeHead(400);res.end()}
})
server.requestTimeout=20000;server.headersTimeout=10000;server.maxConnections=16
server.listen(Number(process.env.YOYO_RELAY_PORT??3181),process.env.YOYO_RELAY_BIND??'172.17.0.1')
process.on('SIGTERM',()=>server.close(()=>process.exit(0)))
