import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { SocialStore } from '../src/social-store.mjs'
import { SocialMaintenance } from '../src/social-maintenance.mjs'
import { MemoryLayer } from '../src/memory-layer.mjs'
import { Motivation } from '../src/motivation.mjs'
import { TeamHost } from '../src/team-host.mjs'
import { ROLE_TOOLS } from '../src/team-store.mjs'

// Documentation drifts silently: a default changes in code, the config block keeps
// quoting the old number, and an operator tunes the wrong value. This test reads
// the documented defaults and compares them with what the code actually does.
function documentedDefaults(){
  const text=readFileSync(new URL('../deploy/README.md',import.meta.url),'utf8')
  const block=text.slice(text.indexOf('```yaml'),text.indexOf('```',text.indexOf('```yaml')+7))
  const found={}
  for(const line of block.split(/\r?\n/)){
    const match=line.match(/^\s{2,}([A-Za-z]+):\s+([0-9]+(?:\.[0-9]+)?)\s*(?:#.*)?$/)
    if(match)found[match[1]]=Number(match[2])
  }
  return found
}

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'yoyo-defaults-'))
  const store=new Store(join(dir,'data.sqlite')),data=new SocialStore(store)
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  return {store,data}
}

test('the documented defaults are the defaults the code actually uses',async t=>{
  const {data}=fixture(t),documented=documentedDefaults()
  for(const key of ['quietMs','maxSteps','turnMs','recallLimit','maxDeltaPerHour','pageEvents','nightHour'])
    assert.equal(typeof documented[key],'number','deploy/README.md 写明了 '+key)

  // Memory layer: how many summaries one recall returns.
  assert.equal(new MemoryLayer(data).recallLimit,documented.recallLimit)
  // Motivation: the hourly bound on a single preference.
  assert.equal(new Motivation(data).maxPerHour,documented.maxDeltaPerHour)
  // Maintenance: the page size and the night window start.
  const maintenance=new SocialMaintenance(data)
  assert.equal(maintenance.config.pageEvents,documented.pageEvents)
  assert.equal(maintenance.config.nightHour,documented.nightHour)
  // Autonomy core: quiet window, step budget and turn length.
  const social={store:data.store,data,separate:true,sessionId:'main',qq:null}
  const host=new TeamHost(social,{})
  assert.equal(host.coordinator.maxConcurrent,2,'团队并发默认值没有变')
  t.after(()=>host.stop())

  const agentConfig=readFileSync(new URL('../src/social-agent.mjs',import.meta.url),'utf8')
  const defaults=agentConfig.match(/this\.config=\{enabled:false,quietMs:(\d+),attentionMs:\d+,ordinaryMs:\d+,maxSteps:(\d+),turnMs:(\d+)/)
  assert.ok(defaults,'自主活动的默认配置仍然集中在一处')
  assert.equal(Number(defaults[1]),documented.quietMs)
  assert.equal(Number(defaults[2]),documented.maxSteps)
  assert.equal(Number(defaults[3]),documented.turnMs)
})

test('the same concept keeps one name and one default across layers',()=>{
  const deployReadme=readFileSync(new URL('../deploy/README.md',import.meta.url),'utf8')
  const teamDoc=readFileSync(new URL('../docs/team-runtime.md',import.meta.url),'utf8')
  const memoryDoc=readFileSync(new URL('../docs/memory-layer.md',import.meta.url),'utf8')
  const motivationDoc=readFileSync(new URL('../docs/humanlike-motivation.md',import.meta.url),'utf8')
  // Token reporting: the wording the panel shows and the wording the ledger note uses.
  assert.match(deployReadme,/recallLimit: 8/)
  assert.match(teamDoc,/Token 未上报/)
  // Page size is described with the same number everywhere it is mentioned.
  const pageSizes=new Set([...memoryDoc.matchAll(/(?:每页|一次整理最多覆盖|一次最多覆盖)\s*(\d+)\s*条/g)].map(match=>match[1]))
  assert.deepEqual([...pageSizes],['120'],'整理分页条数在各处一致')
  // The hourly preference bound is quoted with one number, and the single manual
  // revision cap stays a different number instead of being confused with it.
  const bounds=new Set([...motivationDoc.matchAll(/maxDeltaPerHour[：:\s]*0\.(\d+)/g)].map(match=>match[1]))
  assert.deepEqual([...bounds],['45'],'偏好小时上限在各处一致')
  const manual=new Set([...motivationDoc.matchAll(/单次上限\s*0\.(\d+)/g)].map(match=>match[1]))
  assert.deepEqual([...manual],['12'],'手动修订单次上限单独表述')
  // The layer switches are all documented as default-off in one place.
  for(const layer of ['motivation','memory','team'])assert.match(deployReadme,new RegExp(layer+':\\r?\\n\\s+enabled: false'))
})

test('the documented role list is exactly the roles the host accepts',()=>{
  const deployReadme=readFileSync(new URL('../deploy/README.md',import.meta.url),'utf8')
  const teamDoc=readFileSync(new URL('../docs/team-runtime.md',import.meta.url),'utf8')
  const accept=['chat','research','reader','verify','engineer']
  assert.deepEqual(Object.keys(ROLE_TOOLS).sort(),[...accept].sort(),'代码里的角色集合')
  for(const role of accept){
    assert.match(deployReadme,new RegExp('`'+role+'`'),'部署说明写明角色 '+role)
    assert.match(teamDoc,new RegExp('\\| `'+role+'` \\|'),'角色表里有 '+role)
  }
  // The deploy notes must not promise a capability the engineering role lacks.
  assert.match(deployReadme,/`engineer`（仅 public，在隔离执行服务里跑代码，不能发言也读不到窗口）/)
})
