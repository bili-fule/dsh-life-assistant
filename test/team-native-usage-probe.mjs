// Probe: does the installed DSH runtime report token usage anywhere in the event
// stream? One tiny real-model call; prints event types and any usage-like payload.
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
const root=mkdtempSync(join(tmpdir(),'yoyo-usage-probe-')),patch=join(root,'provider.yml')
writeFileSync(patch,'- id: llm-deepseek\n  disabled: false\n')
const {DeepSeekHarness}=await import(pathToFileURL(sdk).href)
const harness=new DeepSeekHarness({profile:'sdk-minimal',patches:[patch],dshHome:join(root,'.dsh'),cwd:root,processCwd:root,
  env:{PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}),HOME:root,USERPROFILE:root,DSH_HOME:join(root,'.dsh'),DEEPSEEK_API_KEY:apiKey()},
  provider:'deepseek-official',model:'deepseek-flash',maxTokens:32})
try{
  const result=await harness.run('回答一个字：甲')
  const shape=result.events.map(event=>({type:event.type,dataKeys:Object.keys(event.data??{})}))
  const usageLike=JSON.stringify(result.events).match(/"[^"]*(usage|token)[^"]*"\s*:\s*[^,}]+/gi)??[]
  console.log(JSON.stringify({resultKeys:Object.keys(result),shape,usageLike:usageLike.slice(0,10)},null,2))
}finally{await harness.close()}
