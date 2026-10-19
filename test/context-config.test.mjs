import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('263K policy modifies the scoped preset, preserves native tools/tags and leaves model capacity unchanged',t=>{
  const dir=mkdtempSync(join(tmpdir(),'life-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const preset=join(dir,'standard.yml'),profile=join(dir,'profile.yml')
  writeFileSync(preset,`- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
`)
  writeFileSync(profile,'- id: llm-pi-ai\n  config:\n    contextWindow: 1000000\n')
  const run=()=>{const r=spawnSync(process.platform==='win32'?'python':'python3',[fileURLToPath(new URL('../deploy/configure-context.py',import.meta.url)),'--preset',preset,'--profile',profile],{encoding:'utf8'});assert.equal(r.status,0,r.stderr)}
  run();const first=readFileSync(profile,'utf8');run();assert.equal(readFileSync(profile,'utf8'),first)
  assert.match(first,/contextWindow: 1000000/);assert.match(first,/!!js process.platform === 'win32'/);assert.match(first,/thresholdRatio: 0.263/);assert.match(first,/retainTokens: 65536/);assert.match(first,/id: command-compact/)
  assert.equal((first.match(/id: compaction-basic/g)??[]).length,1)
  const customized=first.replace('order: 1','order: 7').replace("'@deepseek-ai/dsh-tool-bash'","'custom-shell'")
  writeFileSync(profile,customized);run();assert.match(readFileSync(profile,'utf8'),/order: 7/);assert.match(readFileSync(profile,'utf8'),/'custom-shell'/)
})
