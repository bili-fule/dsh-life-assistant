import { createServer } from 'node:http'
import { randomBytes,timingSafeEqual } from 'node:crypto'
import { mkdirSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'

// Host-configured SDK and provider patch; never accept paths from tool input.
// Separate DSH home/process with no inherited environment or shell tool.
// This is process isolation, not an OS sandbox. Engineering stays containerized.
export class TeamNativeAdapter {
  constructor(config){this.config=config}
  async run({agentId,task,invoke,signal}) {
    const cfg=this.config
    if(!cfg.root||!cfg.sdkModule||!cfg.providerPatch||!cfg.provider||!cfg.model)throw Error('Independent worker runtime is not configured')
    if(!/^[a-zA-Z0-9-]+$/.test(agentId))throw Error('Invalid worker id')
    signal.throwIfAborted()
    const dir=join(resolve(cfg.root),agentId)
    mkdirSync(dir,{recursive:true,mode:0o700})
    const token=randomBytes(32).toString('hex')
    const server=createServer(async(req,res)=>{
      const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token)
      const respond=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
      if(req.method!=='POST'||req.url!=='/'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){respond(403,{error:'Task access denied'});return}
      let method=null
      try{
        let bytes=0;const chunks=[]
        for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw Error('Body too large');chunks.push(chunk)}
        const input=JSON.parse(Buffer.concat(chunks))
        method=input.method
        const result=await invoke(input.method,input.args??{})
        respond(200,result)
      }catch(error){if(process.env.YOYO_TEAM_DEBUG)console.error('[bridge]',method,String(error?.message));respond(400,{error:'Task tool rejected; check scope, role, lease or arguments'})}
    })
    server.requestTimeout=30000
    let harness
    const abort=()=>{void harness?.close().catch(()=>{})}
    try{
      await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)})
      const pluginPath=fileURLToPath(new URL('./team-worker-plugin.mjs',import.meta.url))
      const patch=join(dir,'worker.patch.yml')
      writeFileSync(patch,`- insert:\n    - id: yoyo-team-worker\n      name: ${JSON.stringify(pluginPath)}\n`,{mode:0o600})
      const {DeepSeekHarness}=await import(pathToFileURL(resolve(cfg.sdkModule)).href)
      const env={PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}),...cfg.env,
        HOME:dir,USERPROFILE:dir,DSH_HOME:join(dir,'.dsh'),YOYO_TEAM_ROLE:task.role,YOYO_TEAM_ENDPOINT:`http://127.0.0.1:${server.address().port}/`,YOYO_TEAM_TOKEN:token}
      harness=new DeepSeekHarness({profile:'sdk-minimal',patches:[resolve(cfg.providerPatch),patch],dshHome:join(dir,'.dsh'),cwd:dir,processCwd:dir,env,provider:cfg.provider,model:cfg.model,maxTokens:cfg.maxTokens??8000,initializeTimeoutMs:45000})
      signal.addEventListener('abort',abort,{once:true});signal.throwIfAborted()
      const result=await harness.run(JSON.stringify({role:task.role,goal:task.goal,expiresAt:task.expiresAt,persona:cfg.persona?.()}),{sessionId:agentId})
      signal.throwIfAborted()
      if(result.events.findLast(e=>e.type==='turn/end')?.data.reason?.kind!=='completed')throw Error('Native worker did not complete')
      // Record real token usage when the runtime reports it; never estimate. The
      // host keeps "not reported" apart from a measured zero, so a missing usage
      // interface cannot look like a free run.
      const usage=result.usage??result.tokenUsage??result.stats?.usage??null
      const tokens=Number(usage?.totalTokens??usage?.total??usage?.outputTokens??0)
      const reported=Number.isSafeInteger(tokens)&&tokens>0
      await invoke('usage',{tokens:reported?tokens:0,reported})
      if(result.finalResponse?.trim())await invoke('report',{body:result.finalResponse.slice(0,12000)})
    }finally{
      signal.removeEventListener('abort',abort)
      try{await harness?.close()}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    }
  }
}
