import { request } from 'node:http'
import { mayRead,sourceScopes,boundedText } from './scope.mjs'

// This client can submit a task, never select an executable, mount or credential.
export class DebugHelper {
  constructor(social,config={}){this.social=social;this.socketPath=config.socketPath??'/run/yoyo-debug/helper.sock';this.timeoutMs=config.timeoutMs??15000}
  async call(path,args,signal){
    return new Promise((resolve,reject)=>{
      const body=Buffer.from(JSON.stringify(args)),req=request({socketPath:this.socketPath,path,method:'POST',signal,headers:{'content-type':'application/json','content-length':body.length}},res=>{
        const chunks=[];let bytes=0
        res.on('data',b=>{bytes+=b.length;if(bytes>4*1024*1024)req.destroy(Error('排障结果过大'));else chunks.push(b)})
        res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200)throw Error(data.error??'排障服务未完成');resolve(data)}catch(e){reject(e)}});res.on('error',reject)
      });req.setTimeout(this.timeoutMs,()=>req.destroy(Error('独立排障服务暂时无响应')));req.on('error',reject);req.end(body)
    })
  }
  diagnostics(){
    const s=this.social
    // No messages, labels, identities, tokens, raw errors, arguments or results.
    return {nativeReady:!!s.nativeReady,separateQQ:!!s.separate,focusKind:s.activeView?.focus?s.data.target(s.activeView.focus).kind:null,windowCounts:s.data.db.prepare('SELECT kind,count(*) total,sum(approved) approved FROM yoyo_targets GROUP BY kind').all(),recentTools:s.data.db.prepare('SELECT name,state,created_at FROM tool_runs ORDER BY created_at DESC LIMIT 12').all(),recentTurns:s.data.db.prepare('SELECT state,count(*) total FROM yoyo_turns GROUP BY state').all(),navigationMode:'list_before_open; focus_applies_after_turn; attention_is_not_unread'}
  }
  async start({problem},view,key,signal){
    const scopes=sourceScopes(view.scopes),result=await this.call('/start',{problem:boundedText(problem,12000,'故障描述'),diagnostics:this.diagnostics(),key},signal)
    this.social.store.set('debug_job:'+result.id,{scopes,createdAt:Date.now()})
    this.social.data.db.prepare('INSERT OR IGNORE INTO yoyo_jobs(id,run_key,scopes,created_at,view_id,state,backend) VALUES(?,?,?,?,?,?,?)').run(result.id,key,JSON.stringify(scopes),Date.now(),view.id,result.state,'debug')
    return {...result,scope:scopes,isolation:'independent_container_dsh',next:'用 yoyo_debug_status 查询；补丁不会自动改动生产环境'}
  }
  async status({id},view,signal){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('排障编号无效')
    const job=this.social.store.get('debug_job:'+id)
    if(!job||!job.scopes.every(scope=>mayRead(view,scope)))throw Error('排障任务不在当前资料范围')
    const result=await this.call('/status',{id},signal)
    this.social.data.db.prepare("UPDATE yoyo_jobs SET state=?,notified=CASE WHEN ?='running' THEN notified ELSE 1 END WHERE id=? AND backend='debug'").run(result.state,result.state,id)
    return result
  }
  async patch({id,offset=0},view,signal){
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('补丁分页无效')
    await this.status({id},view,signal)
    return this.call('/patch',{id,offset},signal)
  }
}
