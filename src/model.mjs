import { parseTime } from './time.mjs'

export function parseJSON(s) {
  s=s.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')
  try { return JSON.parse(s) } catch { throw Error('模型没有返回有效 JSON，原消息已保留') }
}
function clean(v,max) { return typeof v==='string' ? v.trim().slice(0,max) : '' }
export function eligibleForStyle(text) { return text.length>=8 && text.length<=700 && !/[\n\r]|转发|聊天记录|群消息|群通知|原文|@所有人|@全体|通知[：:]|[“”「」]/u.test(text) }
export function validateAnalysis(a, input, tasks,{directTexts=[input]}={}) {
  if(!a || typeof a!=='object' || Array.isArray(a)) throw Error('分析格式无效')
  for(const k of ['tasks','updates','ignored','explicit_memories']) if(!Array.isArray(a[k]) || a[k].length>20) throw Error(`分析字段无效: ${k}`)
  const valid={reply:clean(a.reply,2000), tasks:[], updates:[], ignored:[], explicit_memories:[]}
  for(const t of a.tasks) {
    const title=clean(t.title,160),evidence=clean(t.evidence,1000),reason=clean(t.reason,1000)
    if(!title || !evidence || !input.includes(evidence) || !reason || !['open','confirm','waiting'].includes(t.status)) throw Error('新待办缺少原文依据或状态无效')
    const due=parseTime(t.due_at), reminder=parseTime(t.remind_at)
    if(reminder && due && reminder>due) throw Error('截止前提醒时间晚于截止时间')
    valid.tasks.push({title,status:t.status,due_at:due,remind_at:reminder ?? (due ? Math.max(Date.now(),due-3600000):null),priority:['high','normal','low'].includes(t.priority)?t.priority:'normal',reason,evidence})
  }
  for(const u of a.updates) {
    if(!Number.isInteger(u.id) || !tasks.some(t=>t.id===u.id) || !['open','confirm','waiting','done','cancelled'].includes(u.status)) throw Error('更新了不存在的待办或状态无效')
    const patch={status:u.status,reason:clean(u.reason,1000)}
    if(Object.hasOwn(u,'due_at')) patch.due_at=parseTime(u.due_at)
    if(Object.hasOwn(u,'remind_at')) patch.remind_at=parseTime(u.remind_at)
    if(patch.due_at && patch.remind_at && patch.remind_at>patch.due_at) throw Error('提醒时间晚于截止时间')
    valid.updates.push({id:u.id,patch})
  }
  valid.ignored=a.ignored.map(i=>({text:clean(i.text,300),reason:clean(i.reason,600)})).filter(i=>i.text&&i.reason)
  // Explicit memory is independently gated on the current user's text.
  if(directTexts.some(text=>/^(?:请)?(?:帮我)?(?:记住|记一下|我(?:是|的(?:身份|偏好|部门|工作|提醒)))/u.test(text.trim()))) valid.explicit_memories=a.explicit_memories.map(m=>clean(m,1000)).filter(Boolean).slice(0,5)
  valid.style_observation=null
  if(eligibleForStyle(input) && a.style_observation && typeof a.style_observation==='object') {
    const allowed={brevity:['short','balanced','detailed'],tone:['direct','warm','formal'],format:['bullets','prose']}
    const observation={}
    for(const [k,values] of Object.entries(allowed)) if(values.includes(a.style_observation[k])) observation[k]=a.style_observation[k]
    if(Object.keys(observation).length) valid.style_observation=observation
  }
  return valid
}
