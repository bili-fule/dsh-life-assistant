// Probe: can the installed DSH SDK resume an existing session id, in the same
// process and in a fresh process? Small, bounded, real-model calls only.
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { homedir,tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function apiKey(){
  if(process.env.DEEPSEEK_API_KEY)return process.env.DEEPSEEK_API_KEY
  const file=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'.credentials.yaml')
  const line=readFileSync(file,'utf8').split(/\r?\n/).find(row=>row.trim().startsWith('DEEPSEEK_API_KEY:'))
  if(!line)throw Error('no key')
  return line.slice(line.indexOf(':')+1).trim()
}
const sdk=resolve(process.argv[2]??'.local/team-native-runtime/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js')
const root=mkdtempSync(join(tmpdir(),'yoyo-resume-probe-')),patch=join(root,'provider.yml')
writeFileSync(patch,'- id: llm-deepseek\n  disabled: false\n')
const {DeepSeekHarness}=await import(pathToFileURL(sdk).href)
const base={profile:'sdk-minimal',patches:[patch],dshHome:join(root,'.dsh'),cwd:root,processCwd:root,
  env:{PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}),HOME:root,USERPROFILE:root,DSH_HOME:join(root,'.dsh'),DEEPSEEK_API_KEY:apiKey()},
  provider:'deepseek-official',model:'deepseek-flash',maxTokens:64}

const result={}
const h1=new DeepSeekHarness(base)
try{
  const a=await h1.run('回答一个字：甲',{sessionId:'probe-one'})
  result.first=a.finalResponse?.slice(0,40)??null
  try{
    const b=await h1.run('回答一个字：乙',{sessionId:'probe-one'})
    result.sameProcessResume={ok:true,response:b.finalResponse?.slice(0,40)??null,events:b.events.length}
  }catch(error){result.sameProcessResume={ok:false,error:String(error?.message).slice(0,200)}}
}finally{await h1.close()}
const h2=new DeepSeekHarness(base)
try{
  try{
    const c=await h2.run('回答一个字：丙',{sessionId:'probe-one'})
    result.newProcessResume={ok:true,response:c.finalResponse?.slice(0,40)??null,events:c.events.length}
  }catch(error){result.newProcessResume={ok:false,error:String(error?.message).slice(0,200)}}
}finally{await h2.close()}
console.log(JSON.stringify(result,null,2))
