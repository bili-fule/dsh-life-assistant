import { request } from 'node:http'
import { sourceScopes } from './scope.mjs'

export class Executor {
  constructor({socketPath='/run/yoyo-executor/runner.sock',timeoutMs=10000}={}){this.socketPath=socketPath;this.timeoutMs=timeoutMs}
  async call(path,args,signal) {
    const data=Buffer.from(JSON.stringify(args))
    return new Promise((resolve,reject)=>{
      const req=request({socketPath:this.socketPath,path,method:'POST',headers:{'content-type':'application/json','content-length':data.length},signal},res=>{
        let size=0;const chunks=[]
        res.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024)req.destroy(Error('执行结果过大'));else chunks.push(chunk)})
        res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200)throw Error(value.error??'隔离执行失败');resolve(value)}catch(e){reject(e)}})
        res.on('error',reject)
      })
      req.setTimeout(this.timeoutMs,()=>req.destroy(Error('执行服务暂时无响应')));req.on('error',reject);req.end(data)
    })
  }
  async start({code,language='node',project=null,outputs=[]},view,key,signal) {
    if(!['node','python','shell'].includes(language)||typeof code!=='string'||!code.trim()||code.length>50000||project!==null&&typeof project!=='string')throw Error('执行参数无效')
    return this.call('/run',{code,language,project,outputs,key,scopes:sourceScopes(view.scopes)},signal)
  }
}
