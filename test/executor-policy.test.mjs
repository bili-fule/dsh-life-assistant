import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeProject } from '../deploy/executor-policy.mjs'

test('execution cannot launder private project data into a public activity',()=>{
  const privateProject={path:'/private',scopes:['owner'],readOnly:false},publicProject={path:'/public',scopes:['public'],readOnly:false}
  assert.throws(()=>authorizeProject(privateProject,['public']),/无权读取/)
  assert.throws(()=>authorizeProject(publicProject,['public','owner']),/私人资料/)
  assert.equal(authorizeProject(privateProject,['public','owner']),privateProject)
  assert.equal(authorizeProject(publicProject,['public']),publicProject)
  assert.equal(authorizeProject({...publicProject,readOnly:true},['public','owner']).readOnly,true)
  assert.throws(()=>authorizeProject({scopes:[]},['public']),/范围/)
})
