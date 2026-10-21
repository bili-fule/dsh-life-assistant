// Opt-in and bounded: node test/team-native-intent.mjs
// One REAL-model executor started from the intent queue through the real TeamHost,
// against a local fixture database. No QQ connection, no external sends, no
// production data. The provider key is read from the DSH credential store (or the
// environment) and never printed.
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { homedir,tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamHost } from '../src/team-host.mjs'
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
const root=mkdtempSync(join(tmpdir(),'yoyo-intent-real-')),patch=join(root,'provider.yml')
writeFileSync(patch,'- id: llm-deepseek\n  disabled: false\n')

const db=join(root,'fixture.sqlite'),store=new Store(db),data=new SocialStore(store),metrics=new OrchestrationMetrics(store.db)
// The production subject exposes its own implementations to a peer; this fixture
// provides the same two the reader needs, backed by the same store.
const peerTools=new Map([
  ['yoyo_read',async(args,exec,key,view)=>{const messages=data.read(view.id,{...args,limit:args?.limit??20});data.markRead(view.id,messages.map(message=>message.id));return {target:view.focus,messages:messages.map(message=>({id:message.id,sender:message.sender,text:message.text.slice(0,6000)}))}}],
  ['yoyo_recall',async(args,exec,key,view)=>({memories:data.recall(view.id,{query:args?.query??''})})],
])
const social={store,data,separate:true,sessionId:'real-main',qq:null,metrics,peerTools,config:{quietMs:5000}}
const host=new TeamHost(social,{enabled:true,root:join(root,'workers'),sdkModule,providerPatch:patch,provider:'deepseek-official',model,maxTokens:1200,maxSteps:10,leaseMs:600000,env:{DEEPSEEK_API_KEY:apiKey()}})
const group=data.discover({platform:'qq',account:'1',kind:'group',peer:'xmfu'})
data.approve(group.handle,true)
for(const [id,who,text] of [['1','阿南','今天有人开黑吗'],['2','星洛','新游戏叫「双人地牢」，今晚八点开服'],['3','阿南','好，我到时上线']])
  data.ingest({target:group.handle,sender:who,externalId:id,text:who+'：'+text})
const view=data.open(group.handle)
store.set('yoyo_settings',{observeOnly:false,dailySteps:1000})
const activity=data.startActivity(view.id,{goal:'弄清楚星洛提到的游戏叫什么、什么时候开',why:'主人在私聊里问了',step:'读群里的原话'})
const intent=host.intents.create({activityId:activity.activityId,goal:'读 xmfu 群最近的消息，找出星洛提到的游戏名字和开服时间，并把那条原话放到证据板',
  why:'主人想知道',capabilities:['read'],priority:60,viewId:view.id,doneWhen:'拿到游戏名与开服时间',stopWhen:'群里没有这句话'})

const t0=Date.now()
let finished=false,last=''
for(let i=0;i<600;i++){
  host.tick()
  const row=host.intents.get(intent.id)
  const taskState=row.task_id?host.tasks.db.prepare('SELECT state FROM yoyo_team_tasks WHERE id=?').get(row.task_id)?.state:null
  const now=row.state+'/'+(taskState??'-')
  if(process.env.YOYO_INTENT_DEBUG&&now!==last){last=now;console.error('[intent]',i,now)}
  if(['completed','abandoned','blocked'].includes(row.state)){finished=true;break}
  await new Promise(response=>setTimeout(response,500))
}
const wallMs=Date.now()-t0
const row=host.intents.get(intent.id),task=row.task_id?host.tasks.inspect(row.task_id,view.id):null
const usage=task?host.tasks.usage(task.id):null,reports=task?host.tasks.reports(task.id,view.id):[]
const evidence=task?host.tasks.board(view.id,{taskId:task.id}):[]
const events=host.tasks.activityEvents(view.id,{activityId:activity.activityId,limit:20})
const summary={model,wallMs,intent:{state:row.state,attempts:row.attempts,taskId:row.task_id},task:task?{role:task.role,state:task.state}:null,
  usage:usage?{steps:usage.steps,tokens:usage.tokens,tokensReported:!!usage.tokensReported}:null,
  reports:reports.map(entry=>entry.body.slice(0,240)),evidence:evidence.map(entry=>({kind:entry.kind,source:entry.source})),
  events:events.map(event=>event.kind),metrics:metrics.summary(),
  note:'Token 只有在运行时真的上报时才计数；未上报保持 null / tokensReported=false，不记为 0。'}
console.log(JSON.stringify(summary,null,2))
assert.ok(finished,'the queue started and finished the intent within the window')
assert.equal(row.state,'completed','the real branch ended the intent explicitly')
assert.equal(task.role,'reader','capabilities mapped to the narrowest role')
assert.ok(usage.steps>=1,'the executor really stepped')
assert.equal(metrics.summary().counts.subject_exec??0,0,'the subject ran no heavy tool itself')
assert.equal(metrics.summary().timings.worker_run.samples,1)
assert.ok(reports.length>=1,'the branch reported in its own words')
await host.stop();store.close()
console.log('PASS: the intent queue started a real-model executor and the subject executed nothing. Traces: '+root)
