import { createHash } from 'node:crypto'

export const PUBLIC_SCOPE='public'
export function identityPart(value,label='身份') {
  if((typeof value!=='string'&&typeof value!=='number')||!String(value).trim()||String(value).length>160)throw Error(label+'无效')
  return String(value)
}
export function targetKey(platform,account,kind,peer) {
  if(!['qq','wechat','console'].includes(platform)||!['group','private','owner'].includes(kind))throw Error('聊天类型无效')
  return 'chat:'+createHash('sha256').update(JSON.stringify([platform,identityPart(account),kind,identityPart(peer)])).digest('hex')
}
export function sourceScopes(value) {
  if(!Array.isArray(value)||!value.length||value.some(s=>typeof s!=='string'||!s.length))throw Error('资料缺少来源范围')
  return [...new Set(value)].sort()
}
export function mayRead(view,scope) {return scope===PUBLIC_SCOPE||view.scopes.includes(scope)}
export function mayPublish(scopes,targetScope) {return sourceScopes(scopes).every(s=>s===PUBLIC_SCOPE||s===targetScope)}
export function assertPublish(scopes,targetScope) {
  if(!mayPublish(scopes,targetScope))throw Error('本轮阅读过其他范围的资料，请先打开目标窗口再生成发送内容')
}
export function boundedText(value,max=20000,label='内容') {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'应为非空文本，最多 '+max+' 字')
  return value.trim()
}
