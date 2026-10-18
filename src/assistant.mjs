import { formatTime,localParts,inQuietHours,nextQuietEnd } from './time.mjs'

const STATUS={open:'待办',confirm:'待确认',waiting:'等别人',done:'已完成',cancelled:'已取消'}
export function taskLine(t) { return `#${t.id} ${t.title} [${STATUS[t.status]}]${t.due_at?' · '+formatTime(t.due_at):''}` }
export function listTasks(store,all=false) { const tasks=store.tasks(all);return tasks.length ? tasks.map(taskLine).join('\n') : '目前没有待办。把群消息转给我就行。' }
export function learnStyle(store,observation) {
  if(!observation || !store.get('style_learning',true)) return
  const counts=store.get('style_counts',{}), learned=store.get('learned_style',{})
  for(const [key,value] of Object.entries(observation)) {
    counts[key]??={};counts[key][value]=(counts[key][value]??0)+1
    const ranked=Object.entries(counts[key]).sort((a,b)=>b[1]-a[1])
    if(ranked[0][1]>=3) learned[key]=ranked[0][0]
    // Rolling weights let later corrections outweigh old speech patterns.
    if(Object.values(counts[key]).reduce((a,b)=>a+b,0)>30) for(const v of Object.keys(counts[key])) counts[key][v]=Math.floor(counts[key][v]/2)
  }
  store.set('style_counts',counts);store.set('learned_style',learned)
}
export function command(text,store,sourceId) {
  text=text.trim()
  if(/^(?:\/help|帮助|怎么用)$/u.test(text)) return '直接发/转发消息，我会分清待办、待确认和无需办的事。\n/todo 看待办；/all 看历史\n/done 3 完成；/confirm 3 确认；/cancel 3 取消\n/snooze 3 30 推迟提醒30分钟\n/remember 内容；/memory；/forget 2\n/persona 你希望的人设\n/style 查看语言偏好；/learn off 关闭学习；/style reset 清空所学\n/search 关键词 查原文\n/quiet 22 8 免打扰；/digest 9 每日清单时间；/status 状态'
  if(/^(?:\/todo|待办|待办清单|我的待办|今天要做什么)$/u.test(text)) return listTasks(store)
  if(text==='/all') return listTasks(store,true)
  let m=text.match(/^(?:\/(done|confirm|cancel)|(完成|确认|取消))\s*#?(\d+)$/u)
  if(m) {
    const status={done:'done',confirm:'open',cancel:'cancelled',完成:'done',确认:'open',取消:'cancelled'}[m[1]??m[2]]
    const t=store.updateTask(Number(m[3]),{status})
    return taskLine(t)
  }
  m=text.match(/^\/snooze\s+#?(\d+)\s+(\d+)$/u)
  if(m) { const minutes=Number(m[2]);if(minutes<1||minutes>43200) return '推迟分钟数应在 1 到 43200 之间。';const t=store.updateTask(Number(m[1]),{remind_at:Date.now()+minutes*60000});return `已改为 ${formatTime(t.remind_at)} 提醒：${t.title}` }
  m=text.match(/^(?:\/remember|记住[：:]?)\s+([\s\S]+)$/u)
  if(m) { const body=m[1].trim().slice(0,2000),id=store.memory(body,'explicit',sourceId);return `已记住 #${id}：${body}` }
  if(/^(?:\/memory|我的记忆)$/u.test(text)) {const mem=store.memories();return mem.length?mem.map(m=>`#${m.id} ${m.body}`).join('\n'):'还没有长期记忆。可以说“记住：我是某部门的项目负责人”。'}
  m=text.match(/^\/forget\s+#?(\d+)$/u)
  if(m) return store.forget(Number(m[1]))?'已从长期记忆中移除。原始消息仍可在历史中查阅。':'没有这条记忆。'
  m=text.match(/^(?:\/persona|设置人设[：:]?|人设[：:])\s*([\s\S]+)$/u)
  if(m) {store.set('persona',m[1].trim().slice(0,2000));store.audit('persona.set',{sourceId});return '人设已更新，之后的回复会按这个风格来。'}
  if(text==='/persona') return store.get('persona','默认：贴心、不啰嗦的中文事务助理。')
  if(text==='/style reset') {store.set('style_counts',{});store.set('learned_style',{});store.audit('style.reset',{});return '已清空学习到的语言偏好，人设保持原样。'}
  if(text==='/style') return `语言学习${store.get('style_learning',true)?'已开启':'已关闭'}\n当前偏好：${JSON.stringify(store.get('learned_style',{}))}\n至少三次同类观察才会形成偏好；群转发不参与学习。`
  m=text.match(/^\/learn\s+(on|off)$/)
  if(m) {store.set('style_learning',m[1]==='on');return `语言学习已${m[1]==='on'?'开启':'关闭'}。`}
  m=text.match(/^\/search\s+(.+)$/u)
  if(m) {const hits=store.search(m[1]);return hits.length?hits.map(h=>`原文 #${h.id} (${formatTime(h.received_at)})\n${h.text.slice(0,1200)}`).join('\n\n'):'没有找到相关原文。'}
  m=text.match(/^\/quiet\s+(\d{1,2})\s+(\d{1,2})$/u)
  if(m) {if(Number(m[1])>23||Number(m[2])>23)return '小时应为 0 到 23。';store.set('quiet',{start:Number(m[1]),end:Number(m[2])});return `已设置 ${m[1]}:00 至 ${m[2]}:00 免打扰；期间提醒会延后发送。`}
  m=text.match(/^\/digest\s+(\d{1,2}|off)$/u)
  if(m) {if(m[1]!=='off'&&Number(m[1])>23)return '小时应为 0 到 23。';store.set('digest_hour',m[1]==='off'?null:Number(m[1]));return m[1]==='off'?'已关闭每日清单推送。':`每日清单设为北京时间 ${m[1]}:00。`}
  if(text.startsWith('/')) return '这个命令还不支持，发 /help 查看用法。'
  return null
}

export function applyAnalysis(store,row,analysis) {
  return store.transaction(()=>{
    const created=[],duplicates=[]
    for(const t of analysis.tasks) {const r=store.createTask(t,row.id);(r.duplicate?duplicates:created).push(store.task(r.id))}
    const updated=analysis.updates.map(u=>store.updateTask(u.id,u.patch))
    for(const body of analysis.explicit_memories)store.memory(body,'explicit',row.id)
    learnStyle(store,analysis.style_observation)
    const parts=[]
    if(analysis.reply)parts.push(analysis.reply)
    if(created.length)parts.push('已记下：\n'+created.map(taskLine).join('\n'))
    if(updated.length)parts.push('已更新：\n'+updated.map(taskLine).join('\n'))
    if(duplicates.length)parts.push('已有同一待办，未重复添加：'+duplicates.map(t=>'#'+t.id).join('、'))
    if(analysis.ignored.length)parts.push('无需办：\n'+analysis.ignored.map(i=>`${i.text}：${i.reason}`).join('\n'))
    if(analysis.explicit_memories.length)parts.push('已更新你的长期记忆。')
    if(!parts.length)parts.push('这条消息已保存，暂时没有识别出需要你处理的事项。')
    const reply=parts.join('\n\n')
    store.db.prepare("UPDATE inbox SET state='done',result=?,error=NULL WHERE id=?").run(JSON.stringify(analysis),row.id)
    store.enqueue('reply:'+row.id,'reply',reply)
    store.audit('inbox.processed',{id:row.id,created:created.map(t=>t.id),updated:updated.map(t=>t.id)})
    return reply
  })
}

export function schedule(store,now=Date.now()) {
  const quiet=store.get('quiet',{start:22,end:8})
  if(inQuietHours(now,quiet.start,quiet.end)) return
  for(const t of store.tasks().filter(t=>t.status==='open' && t.remind_at && t.remind_at<=now)) {
    if(t.due_at && t.due_at<=now) {
      store.db.prepare("UPDATE outbox SET state='superseded' WHERE unique_key=? AND state='pending'").run(`reminder:${t.id}:${t.revision}`)
      store.enqueue(`overdue:${t.id}:${t.revision}`,'overdue',`这件事已到截止时间：\n${taskLine(t)}\n如果已完成，回复 /done ${t.id}。`,{taskId:t.id,revision:t.revision,now})
    } else store.enqueue(`reminder:${t.id}:${t.revision}`,'reminder',`待办提醒\n${taskLine(t)}\n${t.reason}\n办完回复 /done ${t.id}，稍后再说回复 /snooze ${t.id} 30。`,{taskId:t.id,revision:t.revision,now})
  }
  const p=localParts(now),hour=store.get('digest_hour',9)
  if(hour!==null && p.hour>=hour && store.get('digest_date')!==p.date && store.tasks().length) {
    store.transaction(()=>{store.enqueue('digest:'+p.date,'digest',`今天的事务清单 (${p.date})\n${listTasks(store)}\n待确认事项可回复 /confirm 编号。`,{now});store.set('digest_date',p.date)})
  }
}

export async function deliverOne(store,send,now=Date.now()) {
  const quiet=store.get('quiet',{start:22,end:8})
  const row=store.db.prepare("SELECT * FROM outbox WHERE state='pending' AND next_at<=? ORDER BY CASE kind WHEN 'file' THEN 0 WHEN 'reply' THEN 1 ELSE 2 END,CASE WHEN kind='reply' THEN -id ELSE id END LIMIT 1").get(now)
  if(!row)return false
  if(!['reply','file'].includes(row.kind) && inQuietHours(now,quiet.start,quiet.end)) {store.db.prepare('UPDATE outbox SET next_at=? WHERE id=?').run(nextQuietEnd(now,quiet.end),row.id);return false}
  if(row.task_id) {const t=store.task(row.task_id);if(!t || t.status!=='open'|| t.revision!==row.revision) {store.db.prepare("UPDATE outbox SET state='superseded' WHERE id=?").run(row.id);return false}}
  store.db.prepare("UPDATE outbox SET state='sending' WHERE id=?").run(row.id)
  try {
    await send(row.body,row.unique_key,row.kind)
    store.db.prepare("UPDATE outbox SET state='sent',sent_at=?,error=NULL WHERE id=? AND state='sending'").run(now,row.id)
    store.set('delivery_error',null)
    return true
  } catch(e) {
    const attempts=row.attempts+1
    // Keep retrying on a bounded backoff. Never claim a failed push was delivered.
    store.db.prepare("UPDATE outbox SET state='pending',attempts=?,next_at=?,error=? WHERE id=? AND state='sending'").run(attempts,now+Math.min(3600000,30000*2**Math.min(attempts,7)),String(e.message).slice(0,300),row.id)
    store.set('delivery_error',{at:now,message:'微信消息未送达，已保留待重试；可向机器人发一条消息刷新会话。'})
    return false
  }
}

export function coalesceMediaReplies(store) {
  if(store.db.prepare("SELECT count(*) n FROM inbox WHERE state IN ('pending','processing')").get().n)return
  const rows=store.db.prepare("SELECT o.id,o.unique_key FROM outbox o JOIN inbox_context c ON o.unique_key='reply:'||c.inbox_id WHERE o.state='pending' AND o.kind='reply' AND json_extract(c.context,'$.hasMedia')=1 ORDER BY o.id").all()
  if(rows.length<2)return
  const tasks=store.tasks().filter(t=>t.status!=='waiting').slice(0,7)
  const body=`已整理这批 ${rows.length} 条图片/文件资料，原文、可读取的正文和判断依据都已保存。\n\n${tasks.length?'当前较近的事务：\n'+tasks.map(taskLine).join('\n'):'暂未新增需要办理的事项。'}\n\n发 /todo 查看完整清单。需要详细解释哪份文件，直接告诉我文件名即可。`
  store.transaction(()=>{
    for(const r of rows)store.db.prepare("UPDATE outbox SET state='superseded' WHERE id=? AND state='pending'").run(r.id)
    store.enqueue('media-batch:'+rows.map(r=>r.id).join('-'),'reply',body)
    store.audit('outbox.media_batch',{sourceIds:rows.map(r=>r.id)})
  })
}
