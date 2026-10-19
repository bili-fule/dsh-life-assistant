// Project data visibility and write destinations are separate checks: a public
// activity cannot open a private project, and private inputs cannot be written
// into a project that is subsequently readable by public activities.
export function authorizeProject(grant,scopes) {
  if(!grant||!Array.isArray(grant.scopes)||!grant.scopes.length||grant.scopes.some(s=>typeof s!=='string'||!s)||!Array.isArray(scopes)||!scopes.length)throw Error('项目授权缺少明确资料范围')
  if(!grant.scopes.every(s=>s==='public'||scopes.includes(s)))throw Error('当前活动无权读取此项目')
  if(!grant.readOnly&&!scopes.every(s=>s==='public'||grant.scopes.includes(s)))throw Error('不能将私人资料写入其他范围的项目')
  return grant
}
