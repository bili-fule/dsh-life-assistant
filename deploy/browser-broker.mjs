// Root-owned stdio bridge. Clients can speak MCP, never choose Docker arguments.
import {createServer} from 'node:net'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,chmodSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
const run=promisify(execFile)
const policy=JSON.parse(readFileSync(process.env.YOYO_BROWSER_POLICY??'/etc/yoyo-browser/policy.json','utf8'))
if(!/^sha256:[a-f0-9]{64}$/.test(policy.image))throw Error('Browser image must be pinned')
if(typeof policy.chromium!=='string'||!policy.chromium.startsWith('/opt/'))throw Error('Invalid fixed Chromium path')
const socket=process.env.YOYO_BROWSER_SOCKET??'/run/yoyo-browser/mcp.sock',active=new Map()
async function remove(name){try{await run('docker',['rm','-f',name],{timeout:15000})}catch{/* Already stopped. */}}
// After a broker restart, stale containers must never be adopted by new clients.
const stale=await run('docker',['ps','-aq','--filter','label=yoyo.browser.managed=true'])
for(const id of stale.stdout.trim().split(/\s+/).filter(Boolean))await remove(id)
const server=createServer(client=>{
 if(active.size>=(policy.maxSessions??4)){client.destroy();return}
 const name='yoyo-browser-'+randomUUID(),args=['run','--rm','-i','--name',name,'--label','yoyo.browser.managed=true','--network','yoyo-browser','--dns','223.5.5.5','--dns','1.1.1.1','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--user=65534:65534','--pids-limit=128','--memory=320m','--memory-swap=576m','--cpus=0.4','--shm-size=64m','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--mount','type=bind,src='+policy.chromium+',dst=/chromium,readonly','--env','HOME=/tmp','--env','NODE_OPTIONS=--max-old-space-size=96',policy.image]
 const child=spawn('docker',args,{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}})
 active.set(name,{client,child});child.stderr.resume()
 client.pipe(child.stdin);child.stdout.pipe(client)
 child.stdin.on('error',()=>client.destroy())
 child.once('error',()=>client.destroy());child.once('exit',()=>{active.delete(name);client.end()})
 client.once('close',()=>{child.stdin.destroy();remove(name).finally(()=>active.delete(name))})
 client.on('error',()=>{});child.stdout.on('error',()=>client.destroy())
})
server.listen(socket,()=>chmodSync(socket,0o660))
async function stop(){server.close();for(const [name,{client}] of active){client.destroy();await remove(name)}process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop)
