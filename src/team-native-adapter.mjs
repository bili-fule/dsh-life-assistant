import { createServer } from 'node:http'
import { randomBytes,timingSafeEqual } from 'node:crypto'
import { mkdirSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'

// Host-configured SDK and provider patch; never accept paths from tool input.
// Separate DSH home/process with no inherited environment or shell tool.
// This is process isolation, not an OS sandbox. Engineering stays containerized.
//
// Two lifecycles share one bridge:
//  - run(): one bounded process for a one-shot branch (research, read, engineer).
//  - open(): a resident process for a chat branch, which may suspend and be woken
//    again. The installed SDK can resume a session id inside the same process but
//    refuses an id that already exists in a fresh process ("session ... already
//    exists"), so keeping one native session alive is the only honest way to reuse
//    it; a process restart falls back to a new session with a continuation brief.
export class TeamNativeAdapter {
  constructor(config){this.config=config}
  brief(task,wake){return {role:task.role,goal:task.goal,expiresAt:task.expiresAt,persona:this.config.persona?.(),...(wake?{wake}:{})}}
  opening(task){
    const opening=this.brief(task,null)
    if(!task.wake)return opening
    // A wake is a real delivery, not a nudge to "continue": it names the window,
    // the messages that arrived while the branch was away, and where it left off.
    return this.brief(task,{kind:task.wake.kind,after:task.wake.after,through:task.wake.through,count:task.wake.count,
      messages:task.wake.messages??[],
      instruction:'这个窗口在你挂起之后有新消息，原文已在上面。接着处理它们；需要更早的上下文再用 team_read。不需要主体批准。处理完如果还要等后续，用 team_pause 说明原因；确定这个聊天活动结束时用 team_finish 说明结果。'})
  }
  async prepare({agentId,task,invoke,signal}) {
    const cfg=this.config,adapter=this
    if(!cfg.root||!cfg.sdkModule||!cfg.providerPatch||!cfg.provider||!cfg.model)throw Error('Independent worker runtime is not configured')
    if(!/^[a-zA-Z0-9-]+$/.test(agentId))throw Error('Invalid worker id')
    signal.throwIfAborted()
    const dir=join(resolve(cfg.root),agentId)
    mkdirSync(dir,{recursive:true,mode:0o700})
    const token=randomBytes(32).toString('hex')
    // The bridge must call the *current* run's authority, not the one the session
    // was opened with: a resumed prompt has a fresh lease and fresh fences.
    let bridge=invoke
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
        const result=await bridge(input.method,input.args??{})
        respond(200,result)
      }catch(error){if(process.env.YOYO_TEAM_DEBUG)console.error('[bridge]',method,String(error?.message));respond(400,{error:'Task tool rejected; check scope, role, lease or arguments'})}
    })
    server.requestTimeout=30000
    let harness=null,closed=false
    const abort=()=>{void close().catch(()=>{})}
    const close=async()=>{
      if(closed)return
      closed=true
      signal.removeEventListener('abort',abort)
      try{await harness?.close()}finally{server.closeAllConnections();await new Promise(done=>server.close(done))}
    }
    await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)})
    const pluginPath=fileURLToPath(new URL('./team-worker-plugin.mjs',import.meta.url))
    const patch=join(dir,'worker.patch.yml')
    writeFileSync(patch,`- insert:\n    - id: yoyo-team-worker\n      name: ${JSON.stringify(pluginPath)}\n`,{mode:0o600})
    const {DeepSeekHarness}=await import(pathToFileURL(resolve(cfg.sdkModule)).href)
    const env={PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}),...cfg.env,
      HOME:dir,USERPROFILE:dir,DSH_HOME:join(dir,'.dsh'),YOYO_TEAM_ROLE:task.role,YOYO_TEAM_ENDPOINT:`http://127.0.0.1:${server.address().port}/`,YOYO_TEAM_TOKEN:token}
    harness=new DeepSeekHarness({profile:'sdk-minimal',patches:[resolve(cfg.providerPatch),patch],dshHome:join(dir,'.dsh'),cwd:dir,processCwd:dir,env,provider:cfg.provider,model:cfg.model,maxTokens:cfg.maxTokens??8000,initializeTimeoutMs:45000})
    signal.addEventListener('abort',abort,{once:true})
    return {agentId,close,
      // `call` is the bridge of the current run, not the one this session was
      // opened with: a resumed prompt must act with the live lease.
      async prompt(task,call=invoke){
        signal.throwIfAborted()
        bridge=call
        const result=await harness.run(JSON.stringify(adapter.opening(task)),{sessionId:agentId})
        signal.throwIfAborted()
        if(result.events.findLast(e=>e.type==='turn/end')?.data.reason?.kind!=='completed')throw Error('Native worker did not complete')
        // Record real token usage when the runtime reports it; never estimate. The
        // installed runtime reports it per assistant message, so the run's cost is
        // the sum of those usage blocks. A run with no usage block at all stays
        // "not measured" instead of pretending to be free.
        const direct=result.usage??result.tokenUsage??result.stats?.usage??null
        let tokens=Number(direct?.totalTokens??direct?.total??direct?.outputTokens??0),reported=Number.isSafeInteger(tokens)&&tokens>0
        if(!reported){
          const summed=result.events.filter(event=>event.type==='assistant/message'&&event.data?.usage).reduce((total,event)=>{
            const usage=event.data.usage
            total.input+=Number(usage.inputTokens??0);total.output+=Number(usage.outputTokens??0)
            total.cacheRead+=Number(usage.cacheReadTokens??0);total.total+=Number(usage.totalTokens??0)
            return total
          },{input:0,output:0,cacheRead:0,total:0})
          if(summed.total>0){tokens=summed.total;reported=true}
        }
        // After a pause the task is already suspended, so the host rightly refuses
        // to record anything for it. That is not an error of the run.
        try{await call('usage',{tokens:reported?tokens:0,reported})}catch{/* lease already released */ }
        if(result.finalResponse?.trim()){try{await call('report',{body:result.finalResponse.slice(0,12000)})}catch{/* lease already released */ }}
        return result
      }}
  }
  // One-shot branch: its own process, closed at the end.
  async run({agentId,task,invoke,signal}) {
    const session=await this.prepare({agentId,task,invoke,signal})
    try{return await session.prompt(task)}
    finally{await session.close()}
  }
  // Resident chat branch: the process and the native session survive a suspension
  // so the next message continues the very same conversation.
  async open({agentId,task,invoke,signal}) {
    const session=await this.prepare({agentId,task,invoke,signal})
    return {agentId,prompt:(next,call)=>session.prompt(next,call),close:session.close}
  }
}
