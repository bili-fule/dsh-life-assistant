export const ZONE = 'Asia/Shanghai'
export function localParts(now = Date.now()) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
  return { date: p.slice(0, 10), hour: Number(p.slice(11, 13)), minute: Number(p.slice(14, 16)), text: p }
}
export function formatTime(ms) { return ms ? localParts(ms).text : '未定时间' }
export function parseTime(value, { nullable = true } = {}) {
  if (value == null || value === '') { if (nullable) return null; throw Error('需要明确时间') }
  // Refuse dates with no offset: the host's timezone must never determine a deadline.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw Error('时间必须包含时区')
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw Error('时间无效')
  const ymd = value.slice(0, 10)
  if (ymd !== new Date(ymd + 'T00:00:00Z').toISOString().slice(0, 10)) throw Error('日期无效')
  return ms
}
export function inQuietHours(now, start = 22, end = 8) {
  const h = localParts(now).hour
  if (start === end) return false
  return start > end ? h >= start || h < end : h >= start && h < end
}
export function nextQuietEnd(now, end = 8) {
  const p = localParts(now)
  let next = Date.parse(`${p.date}T${String(end).padStart(2,'0')}:00:00+08:00`)
  if (next <= now) next += 86400000
  return next
}
