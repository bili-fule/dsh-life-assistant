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

// A continuing subject reads its own windows and may speak in any of them: the
// window it happens to be looking at is a position, not a permission. What must
// never cross is the boundary between independent subjects, so an outbound
// message may only carry material from the target's own platform. Read-only
// material (public web) is always allowed. `platformOf` resolves a scope to its
// platform; the store owns that lookup so a revoked target resolves to null.
export function assertOutbound(scopes,targetScope,platformOf=()=>null) {
  const target=platformOf(targetScope)
  if(!target)throw Error('发件目标缺少平台归属，无法核对资料边界')
  for(const scope of sourceScopes(scopes)){
    if(scope===PUBLIC_SCOPE||scope===targetScope)continue
    if(platformOf(scope)!==target)throw Error('不能把另一个独立主体的资料发到这个窗口')
  }
}
export function boundedText(value,max=20000,label='内容') {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'应为非空文本，最多 '+max+' 字')
  return value.trim()
}
