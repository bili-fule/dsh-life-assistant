import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync,readFileSync,readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The audit is only worth having if it cannot drift from the repository. These
// checks fail when a plan grows an acceptance item, when a test is added or
// removed, when a cited test file disappears, or when a ✅ row stops citing one.
const root=new URL('../',import.meta.url)
const read=path=>readFileSync(new URL(path,root),'utf8')
const audit=read('docs/plan-acceptance-audit.md')

function marker(){
  const found=audit.match(/<!-- acceptance-audit: motivation=(\d+) memory=(\d+) multiagent=(\d+) tests=(\d+) -->/)
  assert.ok(found,'the audit states what it was written against')
  return {motivation:Number(found[1]),memory:Number(found[2]),multiagent:Number(found[3]),tests:Number(found[4])}
}
// Table rows of the acceptance table inside one section, header and separator excluded.
function tableRows(text,heading){
  const start=text.indexOf(heading)
  assert.notEqual(start,-1,'section '+heading+' exists')
  const lines=text.slice(start).split('\n').slice(1)
  const rows=[]
  for(const line of lines){
    if(!line.startsWith('|')){if(rows.length)break;else continue}
    if(/^\|\s*-{2,}/.test(line)||/^\|\s*(场景|验收场景)/.test(line))continue
    rows.push(line)
  }
  return rows
}
function numberedItems(text,heading){
  const start=text.indexOf(heading)
  assert.notEqual(start,-1,'section '+heading+' exists')
  return text.slice(start).split('\n').filter(line=>/^\d+\.\s/.test(line))
}

test('the acceptance audit matches the plans it claims to cover',()=>{
  const stated=marker()
  const motivation=read('docs/plans/humanlike-motivation-plan.md')
  const memory=read('docs/plans/humanlike-memory-plan.md')
  const multiagent=read('docs/plans/artex-multi-agent-plan.md')
  assert.equal(tableRows(motivation,'## 12.').length,stated.motivation,'动机计划 §12 的验收项数与自查表一致')
  assert.equal(tableRows(memory,  '| 验收场景 | 必须表现 |').length,stated.memory,'记忆计划 §15 的验收项数与自查表一致')
  assert.equal(numberedItems(multiagent,'## 13.').length,stated.multiagent,'多 Agent 计划 §13 的验收项数与自查表一致')
})

test('every ✅ row of the audit cites a test file that exists',()=>{
  const rows=audit.split('\n').filter(line=>line.startsWith('|')&&line.includes('✅'))
  assert.ok(rows.length>=20,'the audit really marks verified rows')
  for(const row of rows)
    assert.match(row,/`test\/[a-z0-9-]+\.test\.mjs`/,'verified rows name their test file: '+row.slice(0,60))
  const cited=new Set([...audit.matchAll(/`(test\/[a-z0-9-]+\.test\.mjs)`/g)].map(match=>match[1]))
  for(const path of cited)assert.equal(existsSync(new URL(path,root)),true,'cited test exists: '+path)
})

test('the audit counts the tests this repository actually declares',()=>{
  const stated=marker()
  const files=readdirSync(new URL('test/',root)).filter(name=>name.endsWith('.test.mjs'))
  const declared=files.reduce((total,name)=>total+readFileSync(new URL('test/'+name,root),'utf8').split('\n').filter(line=>line.startsWith('test(')).length,0)
  assert.equal(declared,stated.tests,'自查表写的测试总数与仓库里声明的测试数一致')
  // Sanity: the audit is not silently describing an older layout.
  for(const plan of ['humanlike-motivation-plan','humanlike-memory-plan','artex-multi-agent-plan'])
    assert.equal(existsSync(new URL('docs/plans/'+plan+'.md',root)),true)
})

test('rows that need a real environment say so instead of claiming a test',()=>{
  const pending=audit.split('\n').filter(line=>line.startsWith('|')&&line.includes('⏳'))
  assert.ok(pending.length>=2,'the audit is honest about what cannot be proven here')
  for(const row of pending)assert.equal(row.includes('✅'),false,'a row is either verified or pending, not both')
  assert.match(audit,/容器级隔离未实现/)
  assert.match(audit,/语义向量检索/)
})
