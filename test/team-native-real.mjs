// Opt-in and bounded: node test/team-native-real.mjs
// Two REAL-model DSH workers on one activity, against a local fixture database.
// No QQ connection, no external sends, no production data. The provider key is
// read from the DSH credential store (or the environment) and never printed.
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { homedir,tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { TeamCoordinator } from '../src/team-coordinator.mjs'
import { TeamNativeAdapter } from '../src/team-native-adapter.mjs'

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
const root=mkdtempSync(join(tmpdir(),'yoyo-real-')),patch=join(root,'provider.yml')
writeFileSync(patch,'- id: llm-deepseek\n  disabled: false\n')

function world(){
  const dir=mkdtempSync(join(tmpdir(),'yoyo-real-db-')),store=new Store(join(dir,'real.sqlite')),data=new SocialStore(store)
  const group=data.discover({platform:'qq',account:'1',kind:'group',peer:'xmfu'}),owner=data.discover({platform:'qq',account:'1',kind:'private',peer:'owner'})
  data.approve(group.handle,true);data.approve(owner.handle,true)
  for(const [id,who,text] of [['1','阿南','今天有人开黑吗'],['2','星洛','新游戏叫「双人地牢」，今晚八点开服'],['3','阿南','好，我到时上线'],['4','星洛','记得先更新客户端'],['5','阿南','收到']])
    data.ingest({target:group.handle,sender:who,externalId:id,text:who+'：'+text})
  data.ingest({target:owner.handle,sender:'owner',externalId:'p1',text:'帮我去 xmfu 群看看星洛说的新游戏'})
  const view=data.open(group.handle)
  const activity=data.startActivity(view.id,{goal:'弄清楚星洛提到的游戏叫什么、什么时候开',why:'主人在私聊里问了',step:'读群里的原话'})
  return {store,data,view,activity,tasks:new TeamStore(data)}
}

async function phase(name,{parallel}){
  const {data,view,activity,tasks,store}=world()
  const reader=tasks.create({key:name+'-reader',role:'reader',viewId:view.id,expiresAt:Date.now()+600000,activityId:activity.activityId,maxSteps:8,
    goal:'你只读这个 XP 群窗口。用 team_read 读完最近的消息，找出星洛提到的游戏名字和开服时间。用 team_evidence 把读到的那句原话记成 finding，source 写 "群消息2"。然后用 team_ask 问向任务 '+`__SIBLING__`+'，问题写「那个游戏叫什么名字、几点开服？」。最后用 team_report 说明你查到了什么。'})
  const sibling=tasks.create({key:name+'-sibling',role:'reader',viewId:view.id,expiresAt:Date.now()+600000,activityId:activity.activityId,maxSteps:8,
    goal:'你和另一个分支在查同一件事。用 team_read 读这个 XP 群窗口，自己确认星洛说的游戏名字和开服时间。用 team_events 查看同一活动的事件；如果暂时没有别分支的问题，就用 team_wait_event(seconds=25) 在宿主里等一次（不要空转、不要提前结束），拿到问题后用 team_answer 回答它（答案必须来自你读到的原话）。最后 team_report 说明你答了什么。'})
  data.db.prepare('UPDATE yoyo_team_tasks SET goal=replace(goal,?,?) WHERE id=?').run('__SIBLING__',sibling.id,reader.id)
  const steps=new Map(),started=[]
  const tools={pack:async()=>({pack:null}),read:async({view:runView,args})=>({target:runView.focus,window:'xmfu',messages:data.read(runView.id,{limit:args?.limit??20}).map(m=>({id:m.id,sender:m.sender,text:m.text}))}),recall:async()=>({results:[]}),step:async({agentId})=>{
    const {task}=tasks.authority(agentId),used=(steps.get(task.id)??0)+1
    steps.set(task.id,used)
    if(used>(task.max_steps??8))throw Error('预算到达')
    return {ok:true}
  }}
  const adapter=new TeamNativeAdapter({root, sdkModule,providerPatch:patch,provider:'deepseek-official',model,maxTokens:1200,
    env:{DEEPSEEK_API_KEY:apiKey()}})
  const coordinator=new TeamCoordinator({tasks,adapter,tools,maxConcurrent:2})
  const t0=Date.now()
  if(parallel){
    const a=coordinator.start(reader.id),b=coordinator.start(sibling.id)
    assert.ok(a.started&&b.started)
    await Promise.all([coordinator.settle(reader.id),coordinator.settle(sibling.id)])
  }else{
    assert.ok(coordinator.start(reader.id).started);await coordinator.settle(reader.id)
    assert.ok(coordinator.start(sibling.id).started);await coordinator.settle(sibling.id)
  }
  const wallMs=Date.now()-t0
  const events=data.db.prepare('SELECT id,event_id,kind,from_task,to_task,ref,body FROM yoyo_team_events ORDER BY id').all()
  const reports=data.db.prepare('SELECT task_id,body FROM yoyo_team_reports ORDER BY id').all()
  const states=data.db.prepare('SELECT id,role,state,agent_id FROM yoyo_team_tasks').all()
  // Cost comes from the real usage ledger. The runtime reports usage per assistant
  // message, so this is either a measurement or an explicit absence - never a 0.
  const usageRows=store.db.prepare('SELECT task_id,sum(tokens) tokens,max(tokens_reported) reported,sum(steps) steps FROM yoyo_team_usage GROUP BY task_id').all()
  const tokens=usageRows.reduce((total,row)=>total+Number(row.tokens??0),0)
  const reported=usageRows.length>0&&usageRows.every(row=>row.reported===1)
  store.close()
  return {name,wallMs,parallel,steps:Object.fromEntries(steps),events,reports,states,tokens,reported,
    question:events.find(e=>e.kind==='question')??null,answer:events.find(e=>e.kind==='answer')??null,
    evidence:reports.length}
}

const sequential=await phase('串行',{parallel:false})
const concurrent=await phase('并行',{parallel:true})
const summary={model,
  serial:{wallMs:sequential.wallMs,steps:sequential.steps,events:sequential.events.length,tokens:sequential.tokens,tokensReported:sequential.reported},
  parallel:{wallMs:concurrent.wallMs,steps:concurrent.steps,events:concurrent.events.length,tokens:concurrent.tokens,tokensReported:concurrent.reported},
  question:concurrent.question?.body??null,answer:concurrent.answer?.body??null,
  answered:!!concurrent.answer,asked:!!concurrent.question,
  reports:concurrent.reports.map(row=>row.body.slice(0,200)),states:concurrent.states.map(row=>({role:row.role,state:row.state})),
  tokensNote:sequential.tokens+concurrent.tokens>0?'Token 来自运行时上报，未上报的尝试仍标为未测量':'Token 未测量'}
console.log(JSON.stringify(summary,null,2))
assert.ok(concurrent.question,'a real model asked its sibling a question')
assert.ok(concurrent.answer,'a real model answered it after waiting in the host')
assert.equal(concurrent.answer.ref,concurrent.question.event_id,'the answer points at the question')
assert.ok(concurrent.reports.length>=2,'both branches reported')
console.log('PASS: two real-model workers asked and answered through the bus. Traces: '+root)
