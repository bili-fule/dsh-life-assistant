import { normalizeTitle } from './store.mjs'

export const communicationParameters={type:'array',maxItems:10,items:{type:'object',properties:{pattern:{type:'string'},context:{type:'string'},rationale:{type:'string'},guidance:{type:'string'},basis:{type:'string',enum:['hypothesis','self_report']},reason_quote:{type:'string'},pattern_explicit:{type:'boolean'},sources:{type:'array',items:{type:'object',properties:{id:{type:'integer'},quote:{type:'string'}},required:['id','quote']}},replace_ids:{type:'array',items:{type:'integer'}}},required:['pattern','context','rationale','guidance','basis','sources']}}

export function communicationState(store,{all=false}={}) {
  if(!all&&!store.get('style_learning',true))return []
  return store.db.prepare('SELECT * FROM communication_insights WHERE active=1 ORDER BY confidence DESC,updated_at DESC LIMIT ?').all(all?200:8).map(row=>({...row,rationaleStatus:row.basis==='self_report'?'self_report':'hypothesis',rationaleConfidence:row.basis==='self_report'?0.95:Math.min(0.6,row.confidence),sources:store.db.prepare('SELECT inbox_id,quote FROM communication_sources WHERE insight_id=? LIMIT ?').all(row.id,all?10:3).map(s=>all?s:{...s,quote:s.quote.slice(0,200)})}))
}
export function forgetCommunication(store,id,reason='forgotten') {
  const changed=store.db.prepare('UPDATE communication_insights SET active=0 WHERE id=?').run(id).changes
  if(!changed)return 0
  store.db.prepare('INSERT OR REPLACE INTO communication_retirements VALUES (?,?,?)').run(id,store.db.prepare('SELECT coalesce(max(id),0) id FROM inbox').get().id,reason)
  store.audit('communication.forget',{id,reason})
  return changed
}
export function resetCommunication(store) {
  for(const row of store.db.prepare('SELECT id FROM communication_insights WHERE active=1').all())forgetCommunication(store,row.id,'reset')
}
export function organizeCommunication(store,args,{throughId,directSource}) {
  const items=args.communication??[],retire=args.communication_retire??[]
  if(!Array.isArray(items)||!Array.isArray(retire)||items.length>10||retire.length>20)throw Error('表达分析数量无效')
  if(!store.get('style_learning',true))return {saved:[],disabled:true}
  const saved=[]
  for(const item of items) {
    const text={}
    for(const [key,max] of Object.entries({pattern:400,context:500,rationale:800,guidance:600})) {
      if(typeof item[key]!=='string'||!item[key].trim()||item[key].length>max)throw Error('表达分析需要模式、场景、原因假设和回应策略')
      text[key]=item[key].trim()
    }
    if(!['hypothesis','self_report'].includes(item.basis)||!Array.isArray(item.sources)||!item.sources.length||item.sources.length>10)throw Error('表达分析需要证据和推断类型')
    const sources=item.sources.map(s=>{
      const row=directSource(store,s.id)
      if(!row||s.id>throughId||typeof s.quote!=='string'||!s.quote.trim()||s.quote.length>2000||!row.direct_text.includes(s.quote)||/\[引用\]|\[合并转发|转发[：:]|群通知/u.test(s.quote))throw Error('表达分析必须引用用户直接发言')
      return s
    })
    if(item.basis==='self_report'&&(typeof item.reason_quote!=='string'||!/(?:因为|为了|原因|所以|以免|省得|节省|不想.{0,20}(?:浪费|重复|等|麻烦))/u.test(item.reason_quote)||!sources.some(s=>s.quote.includes(item.reason_quote))))throw Error('明确原因需要包含因果说明的逐字 reason_quote；只有表达要求时，原因仍标 hypothesis')
    if(item.pattern_explicit&&!sources.some(s=>/(?:我(?:希望|喜欢|不喜欢|需要|讨厌)|不要|别|直接|请|少.{0,6}(?:解释|废话|客套))/u.test(s.quote)))throw Error('明确表达偏好需要直接要求的证据')
    for(const old of store.db.prepare("SELECT i.*,r.through_id FROM communication_insights i JOIN communication_retirements r ON r.insight_id=i.id WHERE r.reason!='superseded'").all())if(sources.every(s=>s.id<=old.through_id)) {
      const oldSources=store.db.prepare('SELECT inbox_id,quote FROM communication_sources WHERE insight_id=?').all(old.id)
      if(normalizeTitle(old.pattern)===normalizeTitle(text.pattern)||sources.some(s=>oldSources.some(o=>o.inbox_id===s.id&&o.quote===s.quote)))throw Error('旧资料不能恢复已忘记的表达分析')
    }
    const existing=store.db.prepare('SELECT * FROM communication_insights WHERE active=1').all().find(i=>normalizeTitle(i.pattern)===normalizeTitle(text.pattern)&&normalizeTitle(i.context)===normalizeTitle(text.context))
    const now=Date.now()
    const id=existing?.id??Number(store.db.prepare("INSERT INTO communication_insights(pattern,context,rationale,guidance,basis,status,confidence,created_at,updated_at) VALUES (?,?,?,?,?,'hypothesis',0.4,?,?)").run(text.pattern,text.context,text.rationale,text.guidance,item.basis,now,now).lastInsertRowid)
    for(const s of sources)store.db.prepare('INSERT OR IGNORE INTO communication_sources VALUES (?,?,?)').run(id,s.id,s.quote)
    const count=store.db.prepare('SELECT count(DISTINCT inbox_id) n FROM communication_sources WHERE insight_id=?').get(id).n
    const basis=item.basis==='self_report'||existing?.basis==='self_report'?'self_report':'hypothesis'
    const status=basis==='self_report'||item.pattern_explicit||existing?.status==='explicit'?'explicit':count>=3?'supported':'hypothesis',confidence=status==='explicit'?0.95:status==='supported'?0.75:Math.min(0.6,0.3+count*0.1)
    const preserveReason=existing?.basis==='self_report'&&item.basis!=='self_report'
    store.db.prepare('UPDATE communication_insights SET rationale=?,guidance=?,basis=?,reason_quote=?,status=?,confidence=?,updated_at=? WHERE id=?').run(preserveReason?existing.rationale:text.rationale,text.guidance,basis,preserveReason?existing.reason_quote:item.reason_quote??'',status,confidence,now,id)
    for(const old of item.replace_ids??[]) {
      if(old===id)continue
      if(!store.db.prepare('SELECT id FROM communication_insights WHERE id=? AND active=1').get(old))throw Error('要纠正的表达分析不存在')
      store.db.prepare('UPDATE communication_insights SET active=0 WHERE id=?').run(old)
      store.db.prepare("INSERT OR REPLACE INTO communication_retirements VALUES (?,?,'superseded')").run(old,Math.max(...sources.map(s=>s.id)))
    }
    saved.push(id)
  }
  for(const id of retire){if(!Number.isInteger(id))throw Error('表达分析编号无效');forgetCommunication(store,id,'obsolete')}
  return {saved,retired:retire}
}
