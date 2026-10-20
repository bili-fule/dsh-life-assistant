// Root-owned transport. Models cannot choose images, commands, mounts or upstreams.
import { createServer } from 'node:http'
import { spawn,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,lstatSync,chmodSync,chownSync,realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash,randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

const run=promisify(execFile),policy=JSON.parse(readFileSync(process.env.YOYO_DEBUG_POLICY??'/etc/yoyo-debug/policy.json','utf8'))
if(!/^sha256:[a-f0-9]{64}$/.test(policy.image))throw Error('Debug image must be pinned')
const root=policy.data??'/var/lib/yoyo-debug',source=realpathSync(policy.source),socket='/run/yoyo-debug/helper.sock',tokens=new Map(),active=new Map()
const upstream=new URL(policy.upstream);if(upstream.protocol!=='https:'||upstream.username||upstream.password||upstream.search)throw Error('Invalid model origin')
const modelKey=readFileSync(policy.secretFile,'utf8').trim(),hash=s=>createHash('sha256').update(s).digest('hex')
mkdirSync(root,{recursive:true,mode:0o700})
const file=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw Error('任务编号无效');return join(root,id+'.json')}
const load=id=>JSON.parse(readFileSync(file(id),'utf8'))
const save=job=>{writeFileSync(file(job.id)+'.tmp',JSON.stringify(job),{mode:0o600});renameSync(file(job.id)+'.tmp',file(job.id))}
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
async function body(req,limit){let bytes=0;const chunks=[];for await(const b of req){bytes+=b.length;if(bytes>limit)throw Error('请求过大');chunks.push(b)}return JSON.parse(Buffer.concat(chunks))}
async function remove(name){try{await run('docker',['rm','-f',name],{timeout:15000})}catch{}}
function projection(j){return {id:j.id,state:j.state,startedAt:j.startedAt,finishedAt:j.finishedAt??null,sourceRevision:j.sourceRevision,report:j.result?.report??null,commits:j.result?.commits??null,base:j.result?.base??null,head:j.result?.head??null,dirty:j.result?.dirty??null,patchBytes:j.result?.patch?Buffer.byteLength(j.result.patch):0,patchSha256:j.result?.patch?hash(j.result.patch):null,productionChanged:false,error:j.error??null,verification:'独立 DSH 报告；未部署生产'}}
for(const name of readdirSync(root).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const j=load(name.slice(0,-5));if(j.state==='running'){await remove('yoyo-debug-'+j.id.slice(0,24));j.state='interrupted';j.error='排障服务重启，未自动重做';save(j)}}

const proxy=createServer(async(req,res)=>{
 try{
  const token=String(req.headers.authorization??'').replace(/^Bearer /,''),lease=tokens.get(token)
  if(!lease||req.method!=='POST'||req.url!=='/v1/chat/completions')return json(res,{error:'not authorized'},403)
  if(++lease.requests>40)return json(res,{error:'debug model request budget exhausted'},429)
  const data=await body(req,8*1024*1024)
  if(data.model!==policy.model)return json(res,{error:'model is fixed'},403)
  for(const k of ['max_tokens','max_completion_tokens'])if(data[k]!==undefined)data[k]=Math.min(16000,Math.max(1,Number(data[k])||16000))
  const response=await fetch(upstream.href.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+modelKey},body:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(180000)})
  if(!response.ok)return json(res,{error:'model provider request failed',status:response.status},502)
  res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json','cache-control':'no-store'})
  if(!response.body)return res.end()
  const stream=Readable.fromWeb(response.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res)
 }catch{if(!res.headersSent)json(res,{error:'model proxy unavailable'},502);else res.destroy()}
})
await new Promise((yes,no)=>{proxy.once('error',no);proxy.listen(3190,'172.31.254.1',yes)})

const server=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST')return json(res,{error:'POST required'},405)
  const args=await body(req,60000)
  if(req.url==='/start'){
   if(typeof args.key!=='string'||args.key.length>300||typeof args.problem!=='string'||!args.problem.trim()||args.problem.length>12000)throw Error('排障任务无效')
   const id=hash(args.key),path=file(id)
   try{lstatSync(path);return json(res,projection(load(id)))}catch(e){if(e.code!=='ENOENT')throw e}
   if(active.size>=1)return json(res,{error:'独立排障 Agent 正在处理另一项任务'},409)
   if(readdirSync(root).filter(n=>n.endsWith('.json')).length>=50)throw Error('排障存储已达到保留上限，请由管理端归档')
   const directory=join(root,'work',id),work=join(directory,'work');mkdirSync(work,{recursive:true,mode:0o700});chownSync(work,65534,65534)
   const input=join(directory,'task.json');writeFileSync(input,JSON.stringify({id,problem:args.problem,diagnostics:args.diagnostics??{}}),{mode:0o444})
   const sourceRevision=(await run('git',['-C',source,'rev-parse','HEAD'])).stdout.trim(),token=randomBytes(32).toString('hex')
   const j={id,state:'running',startedAt:Date.now(),sourceRevision};save(j);tokens.set(token,{id,requests:0})
   const name='yoyo-debug-'+id.slice(0,24),argv=['run','--rm','--name',name,'--label','yoyo.debug.managed=true','--network=yoyo-debug','--dns','192.0.2.1','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--user=65534:65534','--pids-limit=128','--memory=448m','--memory-swap=896m','--cpus=0.65','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=64m,mode=1777','--mount','type=bind,src='+work+',dst=/work','--mount','type=bind,src='+input+',dst=/input/task.json,readonly','--mount','type=bind,src='+source+',dst=/source,readonly','--env','YOYO_DEBUG_MODEL_TOKEN='+token,'--env','YOYO_DEBUG_MODEL='+policy.model,policy.image]
   const child=spawn('docker',argv,{stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/bin:/bin'}});active.set(id,{child,name});let stderr=''
   child.stderr.on('data',b=>{if(stderr.length<32000)stderr+=b.toString().slice(0,32000-stderr.length)})
   const timer=setTimeout(()=>{j.error='独立排障达到15分钟预算';void remove(name)},900000)
   const finish=code=>{
    if(!active.has(id))return;clearTimeout(timer);tokens.delete(token);active.delete(id)
    try{
     const output=join(work,'result.json'),stat=lstatSync(output)
     if(code!==0||stat.isSymbolicLink()||!stat.isFile()||stat.size>2*1024*1024)throw Error('未取得有效结果')
     const result=JSON.parse(readFileSync(output,'utf8'))
     if(result.completed!==true||typeof result.report!=='string'||typeof result.patch!=='string')throw Error('无效结果')
     j.result={report:result.report.slice(0,24000),patch:result.patch.slice(0,1024*1024),commits:String(result.commits??'').slice(0,6000),base:String(result.base??''),head:String(result.head??''),dirty:String(result.dirty??'').slice(0,2000)};j.state='done'
    }catch{j.state='failed';j.error??='独立 DSH 任务未完成；生产环境未改动'}
    if(stderr)writeFileSync(join(root,id+'.stderr.log'),stderr,{mode:0o600})
    j.finishedAt=Date.now();save(j)
   }
   child.once('error',()=>finish(-1));child.once('close',finish)
   return json(res,projection(j))
  }
  const j=load(args.id)
  if(req.url==='/status')return json(res,projection(j))
  if(req.url==='/patch'){
   if(j.state!=='done'||!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0)throw Error('补丁尚不可读取')
   const patch=j.result.patch,offset=args.offset??0
   return json(res,{id:j.id,offset,nextOffset:offset+12000,done:offset+12000>=patch.length,sha256:hash(patch),text:patch.slice(offset,offset+12000),sourceRevision:j.sourceRevision})
  }
  return json(res,{error:'unknown operation'},404)
 }catch(e){json(res,{error:['ENOENT','EACCES'].includes(e.code)?'排障任务不存在':String(e.message).slice(0,200)},400)}
})
server.listen(socket,()=>chmodSync(socket,0o660))
async function stop(){server.close();proxy.close();tokens.clear();await Promise.all([...active.values()].map(v=>remove(v.name)));process.exit(0)}
process.on('SIGTERM',()=>{void stop()});process.on('SIGINT',()=>{void stop()})
