// Opt-in and bounded: node test/team-native-chat.mjs
// One REAL-model chat executor that keeps the conversation across two native runs:
// it reads, replies, suspends with team_pause, and is woken by a real follow-up
// message in the same window and the same session. Local fixture database, no QQ
// connection, no external sends. The provider key is read from the DSH credential
// store (or the environment) and never printed.
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { homedir,tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { TeamNativeAdapter } from '../src/team-native-adapter.mjs'
import { OrchestrationMetrics } from '../src/orchestration-metrics.mjs'

function apiKey(){
  if(process.env.DEEPSEEK_API_KEY)return process.env.DEEPSEEK_API_KEY
  const file=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'.credentials.yaml')
  const line=readFileSync(file,'utf8').split(/\r?\n/).find(row=>row.trim().startsWith('DEEPSEEK_API_KEY:'))
  if(!line)throw Error('no DEEPSEEK_API_KEY in the DSH credential store')
  const value=line.slice(line.indexOf(':')+1).trim()
  if(!value||value.length<20)throw Error('the DEEPSEEK_API_KEY entry looks empty')
  return value
}

const sdkModule=resolve(process.argv[2]??'.local/team-native-runtime/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js')
const model=process.env.YOYO_REAL_MODEL??'deepseek-flash'
const root=mkdtempSync(join(tmpdir(),'yoyo-chat-real-')),patch=join(root,'provider.yml')
writeFileSync(patch,'- id: llm-deepseek\n  disabled: false\n')

const store=new Store(join(root,'fixture.sqlite')),data=new SocialStore(store),metrics=new OrchestrationMetrics(store.db)
const reads=[]
const peerTools=new Map([
  ['yoyo_read',async(args,exec,key,view)=>{const messages=data.read(view.id,{...args,limit:args?.limit??20});data.markRead(view.id,messages.map(message=>message.id));reads.push({task:key,after:args?.after??0,ids:messages.map(message=>message.id)});return {target:view.focus,messages:messages.map(message=>({id:message.id,sender:message.sender,text:message.text.slice(0,6000)}))}}],
  ['yoyo_recall',async(args,exec,key,view)=>({memories:data.recall(view.id,{query:args?.query??''})})],
])
const social={store,data,separate:true,sessionId:'real-main',qq:{async send(target,text,key){return {messageId:'fixture-'+createHash('sha256').update(key).digest('hex').slice(0,8)}}},
  metrics,peerTools,config:{quietMs:5000}}
const host=new TeamHost(social,{enabled:true,root:join(root,'workers'),sdkModule,providerPatch:patch,provider:'deepseek-official',model,maxTokens:1200,maxSteps:10,leaseMs:600000,env:{DEEPSEEK_API_KEY:apiKey()}})
// Record what each run was asked, so session reuse and the wake brief are checked on
// the real adapter rather than inferred. The adapter keeps one resident session for
// a chat branch (the SDK only resumes an id inside one process).
const runs=[],real=new TeamNativeAdapter({root:join(root,'workers'),sdkModule,providerPatch:patch,provider:'deepseek-official',model,maxTokens:1200,env:{DEEPSEEK_API_KEY:apiKey()}})
host.coordinator.adapter={
  run:async args=>{runs.push({agentId:args.agentId,wake:args.task.wake??null,resident:false});return real.run(args)},
  open:async args=>{
    const session=await real.open(args)
    return {agentId:session.agentId,close:session.close,prompt:async(task,call)=>{
      runs.push({agentId:session.agentId,wake:task.wake??null,resident:true})
      try{return await session.prompt(task,call)}
      catch(error){if(process.env.YOYO_CHAT_DEBUG)console.error('[run-error]',runs.length,String(error?.message));throw error}
    }}
  }
}

const group=data.discover({platform:'qq',account:'1',kind:'group',peer:'xmfu'})
data.approve(group.handle,true)
data.ingest({target:group.handle,sender:'星洛',externalId:'c1',text:'星洛：今晚还来吗？'})
data.ingest({target:group.handle,sender:'阿南',externalId:'c2',text:'阿南：我也想知道'})
const view=data.open(group.handle)
store.set('yoyo_settings',{observeOnly:false,dailySteps:1000})
const activity=data.startActivity(view.id,{goal:'在 xmfu 群接着聊今晚的安排',why:'答应了星洛',step:'先回一句'})
const task=host.tasks.create({key:'chat-live',role:'chat',goal:'你在这个群窗口里接着聊天。先用 team_read 读最近的消息，然后用 team_send 回一句自然的话（replyId 写 chat-1）。回复后如果对方还没回，用 team_pause 说明你在等他们接着说；不要在还有消息没读的时候挂起。',
  viewId:view.id,expiresAt:Date.now()+600000,activityId:activity.activityId,maxSteps:10})
const until=async(predicate,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){if(predicate())return true;await new Promise(response=>setTimeout(response,500))}return false}

const agentId='worker-'+createHash('sha256').update(task.id).digest('hex').slice(0,20)
assert.equal(host.coordinator.start(task.id).started,true)
assert.equal(await until(()=>['suspended','completed','blocked'].includes(host.tasks.inspect(task.id,view.id).state)),true,'the first run ended')
const afterFirst=host.tasks.inspect(task.id,view.id)
const sent=data.db.prepare("SELECT count(*) n FROM yoyo_events WHERE target=? AND kind='outgoing'").get(view.focus).n
assert.equal(sent,1,'the branch really replied once')
assert.equal(afterFirst.state,'suspended','the branch waits for the follow-up instead of ending the conversation')
assert.equal(host.ownsWindow(view.focus),true)

const cursor=afterFirst.chat_through
data.ingest({target:group.handle,sender:'星洛',externalId:'c3',text:'星洛：那说定了，八点见',receivedAt:Date.now()-6000})
data.ingest({target:group.handle,sender:'阿南',externalId:'c4',text:'阿南：我也八点到',receivedAt:Date.now()-6000})
host.tick()
assert.equal(await until(()=>runs.length>=2),true,'the follow-up woke a second run')
const wakeRun=runs.find(run=>run.wake)
assert.equal(wakeRun.wake.kind,'new_messages')
assert.equal(wakeRun.wake.count,2)
assert.equal(wakeRun.wake.after,cursor)
assert.equal(wakeRun.agentId,agentId,'the same identity and the same native session were reused')
assert.equal(wakeRun.wake.messages.length,2,'the wake brief carries the real new text')
assert.equal(wakeRun.wake.messages.some(message=>/八点见/.test(message.text)),true)
assert.equal(await until(()=>['completed','suspended','blocked'].includes(host.tasks.inspect(task.id,view.id).state)&&runs.length>=2),true)

const final=host.tasks.inspect(task.id,view.id),usage=host.tasks.usage(task.id)
const reports=host.tasks.reports(task.id,view.id)
const outgoing=data.db.prepare("SELECT count(*) n FROM yoyo_events WHERE target=? AND kind='outgoing'").get(view.focus).n
const deliveries=host.db.prepare('SELECT count(*) n FROM yoyo_team_deliveries').get().n
const summary={model:{runs:runs.length,wakes:runs.filter(run=>run.wake).length,agentId,resident:runs.every(run=>run.resident)},
  task:{state:final.state,attempt:final.attempt,chatThrough:final.chat_through,wakeCount:final.wake_count},
  reads,outgoing,deliveries,usage,reports:reports.map(entry=>entry.body.slice(0,240)),metrics:metrics.summary(),
  note:'Token 只有运行时真的上报才计数；这里未上报保持「未测量」。'}
console.log(JSON.stringify(summary,null,2))
assert.equal(['completed','suspended'].includes(final.state),true,'the woken run ended on purpose, not by failing')
assert.equal(runs.every(run=>run.resident),true,'both runs used the resident session, not a second create')
assert.equal(final.chat_through>=5,true,'the cursor advanced past the follow-up messages')
assert.equal(deliveries,outgoing,'one delivery row per real message: a repeated reply id never sends twice')
assert.equal(reads.some(read=>read.after>=cursor),true,'the woken branch read from where it left off')
assert.ok(usage.steps>=2,'two prompts really ran under one task')
assert.equal(metrics.summary().counts.chat_routed_to_executor>=1,true)
assert.ok(reports.length>=1)
await host.stop();store.close()
console.log('PASS: one real-model chat executor kept the conversation across a suspend and a message-driven wake. Traces: '+root)
