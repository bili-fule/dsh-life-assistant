// Opt-in: node test/team-native-events.mjs <installed SDK lib/index.js>
// Two real native DSH worker processes share one activity: one asks a question
// through the event bus, the other answers it. No subject relays anything; the
// scripted model stands in for a real model and only sees its own task goal.
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync } from 'node:fs'
import { resolve,dirname,join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { TeamStore } from '../src/team-store.mjs'
import { TeamCoordinator } from '../src/team-coordinator.mjs'
import { TeamNativeAdapter } from '../src/team-native-adapter.mjs'

const sdkModule=resolve(process.argv[2]??'.local/team-native-runtime/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js')
const llm=join(dirname(dirname(dirname(sdkModule))),'dsh-llm','lib','index.js')
const root=mkdtempSync(join(tmpdir(),'yoyo-native-events-')),plugin=join(root,'model.mjs'),patch=join(root,'model.yml')

const dir=mkdtempSync(join(tmpdir(),'yoyo-events-db-')),store=new Store(join(dir,'events.sqlite')),data=new SocialStore(store)
const group=data.discover({platform:'qq',account:'1',kind:'group',peer:'xmfu'})
data.approve(group.handle,true)
const view=data.open(group.handle)
const activity=data.startActivity(view.id,{goal:'弄清楚星洛提到的游戏',why:'主人在私聊里问了',step:'一个分支问，一个分支答'})
const tasks=new TeamStore(data)

// The model only reads its own task goal (the only text a worker is given) and
// then uses the host bridge, exactly like a real model would.
writeFileSync(plugin,`
import { LlmAdapter } from ${JSON.stringify(pathToFileURL(llm).href)}
import { appendFileSync } from 'node:fs'
const LOG=${JSON.stringify(join(root,'bridge.log'))}
class Model extends LlmAdapter {
 resolveModel(provider,model){return Promise.resolve({provider,id:model,name:model})}
 async *stream(options){
  const goal=options.messages.filter(m=>m.role==='user').map(m=>JSON.stringify(m.content)).join(' ')
  const results=options.messages.filter(m=>m.role==='tool').map(m=>JSON.stringify(m)).join(' ')
  // Tool results arrive JSON-stringified inside a text block, so quotes are
  // escaped; comparing against unescaped JSON needs the backslashes removed.
  const flat=results.split('\\\\').join('')
  appendFileSync(LOG,JSON.stringify({goal:goal.slice(0,120),results:results.slice(0,600)})+'\\n')
  const call=(name,args)=>{const body=JSON.stringify(args);return [
    {type:'block-start',index:0,blockType:'tool-call'},
    {type:'tool-call-delta',index:0,id:'c-'+name,name,argumentsDelta:body},
    {type:'block-end',index:0,block:{type:'tool-call',id:'c-'+name,name,arguments:body}},
    {type:'finish',reason:{kind:'tool-calls'}}]}
  // Ending a turn always needs an explicit stop, otherwise the native loop waits.
  const stop=text=>[
    {type:'block-start',index:0,blockType:'text'},
    {type:'text-delta',index:0,text},
    {type:'block-end',index:0,block:{type:'text',text}},
    {type:'finish',reason:{kind:'stop'}}]
  if(flat.includes('"recorded":true')){for(const e of stop('完成'))yield e;return}
  const askTo=(goal.match(/问向任务 ([0-9a-f-]{36})/)??[])[1]??null
  const questionId=(goal.match(/问题编号 ([0-9a-f-]{36})/)??[])[1]??null
  // A tool result tells the model what it already did: an asked question comes
  // back as kind question, an answer as kind answer.
  const asked=flat.includes('"kind":"question"')
  const answered=flat.includes('"kind":"answer"')
  if(askTo&&!asked){for(const e of call('team_ask',{toTask:askTo,question:'那个游戏叫什么名字？'}))yield e;return}
  if(questionId&&!answered){for(const e of call('team_answer',{question:questionId,answer:'叫「双人地牢」，今晚开'}))yield e;return}
  if(asked||answered){for(const e of call('team_report',{body:'问题与答复已写入事件。'}))yield e;return}
  for(const e of stop('没有可做的'))yield e
 }
}
export const name='team-events-model'
export const inject=['llm']
export function apply(ctx){ctx.llm.registerAdapter(['team-events-proof'],new Model())}
`)
writeFileSync(patch,`- id: llm-deepseek\n  disabled: true\n- insert:\n    - id: team-events-model\n      name: ${JSON.stringify(plugin)}\n`)
const adapter=new TeamNativeAdapter({root,sdkModule,providerPatch:patch,provider:'team-events-proof',model:'proof'})
const coordinator=new TeamCoordinator({tasks,adapter,tools:{step:async()=>({ok:true}),pack:async()=>({pack:null})},maxConcurrent:2})

const answerer=tasks.create({key:'answerer',role:'reader',goal:'等待兄弟分支提问',viewId:view.id,expiresAt:Date.now()+300000,activityId:activity.activityId})
const asker=tasks.create({key:'asker',role:'chat',goal:'读群，并且问向任务 '+answerer.id,viewId:view.id,expiresAt:Date.now()+300000,activityId:activity.activityId})

// 1. The asking branch runs as a real native process and publishes a question.
assert.equal(coordinator.start(asker.id).started,true)
await coordinator.settle(asker.id)
const question=data.db.prepare("SELECT * FROM yoyo_team_events WHERE kind='question'").get()
assert.ok(question,'a real native worker published a question through the bridge')
assert.equal(question.to_task,answerer.id,'the question is addressed to the sibling branch')

// 2. The answering branch is a second native process that learns the id from its
// own task goal, the way a model would learn it from team_events.
answerer.goal='回答兄弟分支的问题；问题编号 '+question.event_id
data.db.prepare('UPDATE yoyo_team_tasks SET goal=? WHERE id=?').run(answerer.goal,answerer.id)
assert.equal(coordinator.start(answerer.id).started,true)
await coordinator.settle(answerer.id)

const answer=data.db.prepare("SELECT * FROM yoyo_team_events WHERE kind='answer'").get()
assert.ok(answer,'the second native worker answered')
assert.equal(answer.ref,question.event_id,'the answer is correlated with the question')
assert.equal(answer.from_task,answerer.id,'the host decided who answered')
assert.match(answer.body,/双人地牢/)
const visible=tasks.activityEvents(view.id)
assert.ok(visible.some(event=>event.kind==='answer'),'the answer is visible in the shared activity')
assert.deepEqual(tasks.openQuestions(view.id).filter(open=>open.eventId===question.event_id),[],'the question is no longer open')
assert.equal(data.db.prepare("SELECT count(*) n FROM yoyo_team_tasks WHERE state='completed'").get().n,2,'both native branches ended on their own')
console.log('PASS: two real DSH worker processes exchanged a question and an answer through the event bus. Traces: '+root)
