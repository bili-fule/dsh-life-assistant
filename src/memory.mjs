import { normalizeTitle } from './store.mjs'
import { eligibleForStyle,validateAnalysis } from './model.mjs'
import { learnStyle } from './assistant.mjs'

// These are provenance checks; deciding what is lasting knowledge belongs to the native Agent.
export function directSource(store,id) {
  const row=store.db.prepare('SELECT id,text,external_id,sender,received_at FROM inbox WHERE id=?').get(id)
  if(!row)return null
  const owner=store.get('owner')
  if(owner&&row.sender!==owner)return null
  const wire=store.db.prepare('SELECT payload FROM wire_messages WHERE external_id=?').get(row.external_id)
  if(!wire)return {...row,direct_text:row.text}
  const raw=JSON.parse(wire.payload)
  const direct=(raw.item_list??[]).flatMap(item=>[item.text_item?.text,item.voice_item?.text]).filter(Boolean)
    .filter(text=>!/<(?:msg|appmsg|recordinfo|recorditem)\b/i.test(text)).join('\n')
  return {...row,direct_text:direct}
}

export function memoryState(store) {
  return {
    memories:store.memories().map(m=>({...m,sources:store.db.prepare('SELECT inbox_id,quote FROM memory_sources WHERE memory_id=?').all(m.id)})),
    forgotten:store.db.prepare("SELECT m.id,m.body,m.source_id,r.through_id FROM memories m JOIN memory_retirements r ON r.memory_id=m.id WHERE r.reason='forgotten' ORDER BY r.created_at DESC LIMIT 50").all(),
  }
}

export function organizeMemory(store,args,{throughId=Infinity}={}) {
  const upserts=args.upserts??[],retire=args.retire??[],observations=args.style_observations??[]
  if(!Array.isArray(upserts)||!Array.isArray(retire)||!Array.isArray(observations)||upserts.length>20||retire.length>20||observations.length>30)throw Error('记忆变更数量无效')
  return store.transaction(()=>{
    const saved=[]
    for(const item of upserts) {
      const body=typeof item.body==='string'?item.body.trim():''
      if(!body||body.length>1500||!Array.isArray(item.sources)||!item.sources.length||item.sources.length>10)throw Error('记忆需要内容和消息来源')
      const sources=item.sources.map(s=>{
        const source=directSource(store,s.id),quote=typeof s.quote==='string'?s.quote.trim():''
        if(!source||s.id>throughId||!quote||quote.length>2000||!source.direct_text.includes(quote)||/\[合并转发|\[引用\]|转发[：:]|群通知|群消息|@所有人|@全体/u.test(quote))throw Error('记忆必须引用用户直接消息，不能把转发或猜测当作事实')
        return {id:s.id,quote}
      })
      const forgotten=memoryState(store).forgotten
      for(const m of forgotten)if(sources.every(s=>s.id<=m.through_id)) {
        const oldSources=store.db.prepare('SELECT inbox_id,quote FROM memory_sources WHERE memory_id=?').all(m.id)
        if(normalizeTitle(m.body)===normalizeTitle(body)||sources.some(s=>s.id===m.source_id||oldSources.some(o=>o.inbox_id===s.id&&o.quote===s.quote))||m.body.includes(body)||body.includes(m.body))throw Error('该记忆已被用户忘记，旧资料不能重新学习')
      }
      const replace=[...new Set(item.replace_ids??[])]
      for(const id of replace)if(!Number.isInteger(id)||!store.db.prepare('SELECT id FROM memories WHERE id=? AND active=1').get(id))throw Error('要合并或纠正的记忆不存在')
      const existing=store.memories().find(m=>normalizeTitle(m.body)===normalizeTitle(body))
      if(!existing&&store.memories().length>=100&&!replace.length)throw Error('长期记忆已满，请先合并或淘汰旧条目')
      const id=existing?.id??store.memory(body,'learned',sources[0].id)
      for(const s of sources)store.db.prepare('INSERT OR IGNORE INTO memory_sources VALUES (?,?,?)').run(id,s.id,s.quote)
      for(const old of replace)if(old!==id) {
        store.db.prepare('INSERT OR IGNORE INTO memory_sources SELECT ?,inbox_id,quote FROM memory_sources WHERE memory_id=?').run(id,old)
        store.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(old)
        store.db.prepare("INSERT OR REPLACE INTO memory_retirements VALUES (?,'superseded',?,?)").run(old,Math.max(...sources.map(s=>s.id)),Date.now())
      }
      saved.push(id)
    }
    for(const item of retire) {
      if(!Number.isInteger(item.id)||!['duplicate','obsolete','incorrect'].includes(item.reason))throw Error('淘汰记忆需要编号及原因')
      const m=store.db.prepare('SELECT * FROM memories WHERE id=? AND active=1').get(item.id)
      if(!m)throw Error('记忆不存在或已停用')
      if(m.kind==='explicit')throw Error('用户明确保存的记忆请用有依据的新记忆替换，或由用户要求忘记')
      store.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(item.id)
      store.db.prepare('INSERT OR REPLACE INTO memory_retirements VALUES (?,?,?,?)').run(item.id,item.reason,Number.isFinite(throughId)?throughId:store.db.prepare('SELECT coalesce(max(id),0) id FROM inbox').get().id,Date.now())
    }
    for(const observation of observations) {
      const source=directSource(store,observation.id)
      if(!source||source.id>throughId||!eligibleForStyle(source.direct_text)||store.get('style_source:'+source.id)||!store.get('style_learning',true))continue
      const valid=validateAnalysis({tasks:[],updates:[],ignored:[],explicit_memories:[],style_observation:observation},source.direct_text,[])
      if(valid.style_observation){learnStyle(store,valid.style_observation);store.set('style_source:'+source.id,true)}
    }
    store.audit('memory.organized',{saved,retired:retire.map(r=>r.id)})
    return {ok:true,saved,retired:retire.map(r=>r.id)}
  })
}
