import { mkdirSync,writeFileSync } from 'node:fs'
import { join,relative } from 'node:path'

export function standaloneCommand(text) {
  text=text.trim()
  return text.startsWith('/')||/^(?:帮助|怎么用|待办|待办清单|我的待办|今天要做什么|我的记忆|状态)$/u.test(text)||/^(?:完成|确认|取消)\s*#?\d+$/u.test(text)||/^(?:记住[：:]?\s+|设置人设[：:]?|人设[：:])/u.test(text)
}

export class Batcher {
  constructor(store,config={}) {
    this.store=store
    this.quietMs=Math.max(1000,Math.min(60000,Number(config.batchQuietMs)||15000))
    this.maxWaitMs=Math.max(this.quietMs,Math.min(300000,Number(config.batchMaxWaitMs)||60000))
    this.maxMessages=Math.floor(Math.max(1,Math.min(50,Number(config.batchMaxMessages)||20)))
  }
  members(id) {
    const member=this.store.db.prepare('SELECT batch_id FROM inbox_batch_members WHERE inbox_id=?').get(id)
    return member?this.store.db.prepare('SELECT i.* FROM inbox i JOIN inbox_batch_members b ON b.inbox_id=i.id WHERE b.batch_id=? ORDER BY i.id').all(member.batch_id):[this.store.db.prepare('SELECT * FROM inbox WHERE id=?').get(id)].filter(Boolean)
  }
  ready(now=Date.now()) {
    const first=this.store.db.prepare("SELECT i.*,b.batch_id FROM inbox i LEFT JOIN inbox_batch_members b ON b.inbox_id=i.id WHERE i.state='pending' AND i.next_at<=? AND (b.batch_id IS NULL OR b.batch_id=i.id) ORDER BY i.id LIMIT 1").get(now)
    if(!first)return null
    if(first.batch_id)return this.members(first.id)
    if(first.attempts||this.store.inputContext(first.id)?.agentFinal||standaloneCommand(first.text))return [first]
    const candidates=this.store.db.prepare('SELECT i.*,b.batch_id FROM inbox i LEFT JOIN inbox_batch_members b ON b.inbox_id=i.id WHERE i.id>=? ORDER BY i.id LIMIT ?').all(first.id,this.maxMessages+1)
    const rows=[];let closed=false
    for(const row of candidates) {
      if(row.state!=='pending'||row.next_at>now||row.batch_id||row.sender!==first.sender||row.attempts||this.store.inputContext(row.id)?.agentFinal||standaloneCommand(row.text)||(rows.length&&row.received_at-rows.at(-1).received_at>this.quietMs)){closed=true;break}
      rows.push(row)
      if(rows.length>=this.maxMessages){closed=true;break}
    }
    return rows.length&&(closed||now>=Math.min(rows.at(-1).received_at+this.quietMs,first.received_at+this.maxWaitMs))?rows:null
  }
  claim(rows) {
    const anchor=rows[0].id
    this.store.transaction(()=>{
      for(const row of rows) {
        this.store.db.prepare('INSERT OR IGNORE INTO inbox_batch_members VALUES (?,?)').run(row.id,anchor)
        this.store.db.prepare("UPDATE inbox SET state='processing' WHERE id=?").run(row.id)
      }
      this.store.audit('inbox.batch_claimed',{id:anchor,messageIds:rows.map(r=>r.id)})
    })
  }
  fail(rows,error,now=Date.now()) {
    const attempts=rows[0].attempts+1,failed=attempts>=3
    this.store.transaction(()=>{
      for(const row of rows)this.store.db.prepare('UPDATE inbox SET state=?,attempts=?,next_at=?,error=? WHERE id=?').run(failed?'failed':'pending',attempts,now+30000*attempts,String(error.message).slice(0,300),row.id)
      this.store.set('model_health',{ok:false,at:now,message:'消息分析未完成，原文已保留。'})
      if(failed)this.store.enqueue('failed:'+rows[0].id,'reply',`原文 ${rows.map(r=>'#'+r.id).join('、')} 已保存，但本批处理未完整完成。已执行的工具操作保留记录，可在管理页查看并重试整批。`)
    })
  }
  retry(id) {
    const rows=this.members(id)
    if(rows.some(r=>r.state==='failed')){const anchor=rows[0].id,c=this.store.inputContext(anchor)??{};this.store.setInputContext(anchor,{...c,nativeRetryGeneration:(c.nativeRetryGeneration??0)+1})}
    this.store.transaction(()=>{
      for(const row of rows)this.store.db.prepare("UPDATE inbox SET state='pending',attempts=0,next_at=0,error=NULL WHERE id=? AND state='failed'").run(row.id)
      if(rows.length)this.store.db.prepare("UPDATE outbox SET state='superseded' WHERE unique_key=? AND state='pending'").run('failed:'+rows[0].id)
    })
  }
  async prepare(rows,media,workspace) {
    if(rows.length===1)return media.prepare(rows[0])
    const saved=this.store.inputContext(rows[0].id)?.batchPrepared
    if(saved)return saved
    const parts=[]
    for(const row of rows)parts.push({id:row.id,received_at:row.received_at,direct_text:row.text,...await media.prepare(row)})
    const dir=join(workspace,'batches');mkdirSync(dir,{recursive:true,mode:0o700})
    const path=join(dir,'batch-'+rows[0].id+'.json')
    writeFileSync(path,JSON.stringify(parts,null,2),{mode:0o600})
    const archive=relative(workspace,path),perMessage=Math.floor(40000/parts.length)
    const text=`[连续收到的一批消息，按编号顺序理解；共 ${parts.length} 条。完整原文与提取内容：${archive}。下列资料不足或被截断时，用 read_file 或 Shell 读取完整归档或对应附件，不能假装已读完。]\n\n`+parts.map(p=>{
      const direct=p.hasMedia?'用户本条内容：'+p.direct_text.slice(0,1200)+'\n附件资料：\n':''
      const content=direct+p.text
      return `[原文 #${p.id} · ${new Date(p.received_at).toISOString()}]\n${content.slice(0,perMessage)}${content.length>perMessage?'\n[此条超过展示预算，完整内容见归档和附件]':''}`
    }).join('\n\n')
    const assets=[...new Map(parts.flatMap(p=>p.assets??[]).map(a=>[a.path,a])).values()].slice(0,99)
    const archiveAsset={name:'本批完整消息归档',path:archive,kind:'file'}
    assets.unshift(archiveAsset)
    const prepared={prepared:true,text,assets,hasMedia:parts.some(p=>p.hasMedia),batchIds:rows.map(r=>r.id)}
    const anchorContext=this.store.inputContext(rows[0].id)??{}
    this.store.setInputContext(rows[0].id,{...anchorContext,assets:[...(anchorContext.assets??[]),archiveAsset],batchPrepared:prepared})
    return prepared
  }
}
