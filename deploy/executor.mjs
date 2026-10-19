// Root-owned broker. No model credentials, QQ tokens, chat databases or host shell.
import { createServer } from 'node:http'
import { spawn,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,renameSync,chmodSync,realpathSync } from 'node:fs'
import { resolve,join,relative,isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { authorizeProject } from './executor-policy.mjs'

const run=promisify(execFile),root=process.env.YOYO_EXECUTOR_DATA??'/var/lib/yoyo-executor'
const socket=process.env.YOYO_EXECUTOR_SOCKET??'/run/yoyo-executor/runner.sock'
const policy=JSON.parse(readFileSync(process.env.YOYO_EXECUTOR_POLICY??'/etc/yoyo-executor/policy.json','utf8'))
for(const image of Object.values(policy.images??{}))if(typeof image!=='string'||!/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(image))throw Error('执行镜像必须固定 digest 或已验证的本地镜像 ID')
mkdirSync(root,{recursive:true,mode:0o700});const active=new Map()
const idFor=key=>createHash('sha256').update(key).digest('hex')
function record(id){if(!/^[a-f0-9]{64}$/.test(id))throw Error('任务编号无效');return join(root,id+'.json')}
function load(id){return JSON.parse(readFileSync(record(id),'utf8'))}
function save(job){const p=record(job.id);writeFileSync(p+'.tmp',JSON.stringify(job),{mode:0o600});renameSync(p+'.tmp',p)}
function json(res,data,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data))}
async function kill(name){try{await run('docker',['rm','-f',name],{timeout:15000})}catch(e){/* Already removed containers require no cleanup. */}}
const nodeWrapper=`import {spawnSync} from 'node:child_process';import {readFileSync,realpathSync,statSync} from 'node:fs';import {resolve,relative,isAbsolute} from 'node:path';
const c=JSON.parse(readFileSync('/input/config.json'));const r=spawnSync(c.language==='node'?'node':'sh',['/input/task.'+(c.language==='node'?'mjs':'sh')],{cwd:'/work',env:{PATH:process.env.PATH,HOME:'/work'},encoding:'utf8',timeout:c.timeout,maxBuffer:100000});const files=[];let bytes=0;
for(const name of c.outputs){try{const p=realpathSync(resolve('/work',name)),rel=relative('/work',p);if(rel.startsWith('..')||isAbsolute(rel)||!statSync(p).isFile())continue;const size=statSync(p).size;if(bytes+size>c.maxBytes)continue;const b=readFileSync(p);bytes+=b.length;files.push({name,data:b.toString('base64')})}catch(e){}}
process.stdout.write(JSON.stringify({exitCode:r.status,timedOut:r.error?.code==='ETIMEDOUT',stdout:String(r.stdout??'').slice(0,32000),stderr:String(r.stderr??r.error?.message??'').slice(0,32000),files}));`
const pythonWrapper=`import subprocess,json,os,base64
c=json.load(open('/input/config.json'));files=[];size=0
try:
 r=subprocess.run(['python3','/input/task.py'],cwd='/work',env={'PATH':os.environ['PATH'],'HOME':'/work'},stdout=open('/work/stdout','wb'),stderr=open('/work/stderr','wb'),timeout=c['timeout']/1000)
 result={'exitCode':r.returncode,'timedOut':False}
except subprocess.TimeoutExpired:result={'exitCode':None,'timedOut':True}
for name in c['outputs']:
 p=os.path.realpath(os.path.join('/work',name))
 if p.startswith('/work/') and os.path.isfile(p) and size+os.path.getsize(p)<=c['maxBytes']:
  data=open(p,'rb').read();size+=len(data);files.append({'name':name,'data':base64.b64encode(data).decode()})
result.update(stdout=open('/work/stdout','rb').read(32000).decode(errors='replace'),stderr=open('/work/stderr','rb').read(32000).decode(errors='replace'),files=files)
print(json.dumps(result))`
for(const file of readdirSync(root).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){const job=load(file.slice(0,-5));if(job.state==='running'){await kill(job.container);job.state='interrupted';job.error='执行服务重启，未自动重复执行';save(job)}}

const server=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST')return json(res,{error:'POST required'},405)
  const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>100000)throw Error('请求过大');chunks.push(b)}
  const args=JSON.parse(Buffer.concat(chunks))
  if(req.url==='/capabilities'){
    if(!Array.isArray(args.scopes)||!args.scopes.length||args.scopes.some(s=>typeof s!=='string'))throw Error('资料范围无效')
    const projects=[];for(const [name,grant] of Object.entries(policy.projects??{})){try{authorizeProject(grant,args.scopes);projects.push({name,readOnly:!!grant.readOnly})}catch{}}
    return json(res,{languages:Object.keys(policy.images),projects,network:false,timeoutMs:policy.timeoutMs??120000})
  }
  if(req.url==='/run') {
    if(typeof args.key!=='string'||!args.key||args.key.length>300||typeof args.code!=='string'||!args.code.trim()||args.code.length>50000||!['node','python','shell'].includes(args.language)||!Array.isArray(args.scopes)||args.scopes.some(s=>typeof s!=='string'))throw Error('执行参数无效')
    const id=idFor(args.key),hash=createHash('sha256').update(JSON.stringify(args)).digest('hex')
    if(existsSync(record(id))){const job=load(id);if(job.inputHash!==hash)throw Error('同一个任务不能替换执行内容');return json(res,job)}
    if(active.size>=(policy.concurrency??1))return json(res,{error:'执行器正忙，请稍后继续'},429)
    if(readdirSync(root).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).length>=(policy.maxRetainedJobs??50))throw Error('任务存储已达到保留上限，请由管理端归档')
    if(!Array.isArray(args.outputs)||args.outputs.length>8||args.outputs.some(p=>typeof p!=='string'||p.length>160||isAbsolute(p)||p.split(/[\\/]/).includes('..')))throw Error('导出文件名无效')
    const image=policy.images[args.language];if(!image)throw Error('该执行语言未启用')
    const directory=join(root,'work',id);mkdirSync(directory,{recursive:true,mode:0o755})
    const extension={node:'mjs',python:'py',shell:'sh'}[args.language],script='task.'+extension
    writeFileSync(join(directory,script),args.code,{mode:0o444})
    writeFileSync(join(directory,'config.json'),JSON.stringify({language:args.language,outputs:args.outputs,timeout:policy.timeoutMs??120000,maxBytes:policy.maxExportBytes??20*1024*1024}),{mode:0o444})
    writeFileSync(join(directory,'wrapper.'+(args.language==='python'?'py':'mjs')),args.language==='python'?pythonWrapper:nodeWrapper,{mode:0o444})
    chmodSync(directory,0o755);for(const file of readdirSync(directory))chmodSync(join(directory,file),0o444)
    const job={id,inputHash:hash,state:'running',container:'yoyo-job-'+id.slice(0,24),scopes:args.scopes,startedAt:Date.now(),exitCode:null,timedOut:false,stdout:'',stderr:''}
    const argv=['run','--rm','--name',job.container,'--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--pids-limit=64','--memory='+String(policy.memory??'192m'),'--cpus='+String(policy.cpus??0.5),'--user=65534:65534','--tmpfs','/tmp:rw,nosuid,nodev,size=16m','--tmpfs','/work:rw,nosuid,nodev,size=64m,mode=1777','--mount','type=bind,src='+directory+',dst=/input,readonly','--workdir=/work']
    if(args.project!==null&&args.project!==undefined){
      const grant=authorizeProject(policy.projects?.[args.project],args.scopes)
      const path=realpathSync(grant.path);if(path.includes(','))throw Error('项目路径无效')
      argv.push('--mount','type=bind,src='+path+',dst=/project'+(grant.readOnly?',readonly':''))
    }
    argv.push('--entrypoint',args.language==='python'?'python3':'node',image,args.language==='python'?'/input/wrapper.py':'/input/wrapper.mjs')
    save(job)
    const child=spawn('docker',argv,{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:'/root'}})
    active.set(id,{child,job});const max=policy.maxOutput??32000;let wire='',wireBytes=0
    child.stdout.on('data',b=>{wireBytes+=b.length;if(wireBytes>30*1024*1024){void kill(job.container);job.error='任务导出超出上限'}else wire+=b.toString()})
    child.stderr.on('data',b=>{if(job.stderr.length<max)job.stderr+=b.toString().slice(0,max-job.stderr.length)})
    const timer=setTimeout(()=>{job.timedOut=true;void kill(job.container)},policy.timeoutMs??120000)
    const finish=(code,error)=>{
      if(!active.has(id))return;clearTimeout(timer);job.exitCode=code
      if(!error&&!job.timedOut&&code===0){try{
        const result=JSON.parse(wire);job.exitCode=Number.isInteger(result.exitCode)?result.exitCode:null;job.timedOut=!!result.timedOut
        job.stdout=String(result.stdout??'').slice(0,max);job.stderr=String(result.stderr??'').slice(0,max);job.files=[];let bytes=0
        if(!Array.isArray(result.files)||result.files.length>8)throw Error('导出结果无效')
        for(const f of result.files){if(!args.outputs.includes(f.name)||typeof f.data!=='string')throw Error('导出结果不在指定列表');const data=Buffer.from(f.data,'base64');bytes+=data.length;if(bytes>(policy.maxExportBytes??20*1024*1024))throw Error('导出文件过大');job.files.push({name:f.name,data:data.toString('base64'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')})}
      }catch(e){error=e}}
      job.state=error?'failed':job.timedOut?'timed_out':job.exitCode===0?'done':'failed';if(error)job.error=String(error.message).slice(0,300);job.finishedAt=Date.now();job.outputMayBeTruncated=job.stdout.length>=max||job.stderr.length>=max;save(job);active.delete(id)
    }
    child.once('error',e=>finish(null,e));child.once('close',code=>finish(code,null))
    return json(res,job)
  }
  const job=load(args.id)
  if(req.url==='/status')return json(res,job)
  if(req.url==='/cancel'){await kill(job.container);return json(res,{cancelled:true})}
  if(req.url==='/file'){
    if(job.state!=='done'||typeof args.path!=='string')throw Error('文件暂不可读取')
    const file=job.files?.find(f=>f.name===args.path);if(!file)throw Error('文件不在任务导出列表')
    return json(res,{...file,scopes:job.scopes})
  }
  return json(res,{error:'unknown operation'},404)
 }catch(e){json(res,{error:String(e.message).slice(0,300)},400)}
})
server.listen(socket,()=>{chmodSync(socket,0o660)})
async function stop(){server.close();await Promise.all([...active.values()].map(v=>kill(v.job.container)));process.exit(0)}
process.on('SIGTERM',()=>{void stop()});process.on('SIGINT',()=>{void stop()})
