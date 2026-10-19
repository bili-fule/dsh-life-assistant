import { createHash,timingSafeEqual,createHmac } from 'node:crypto'
import { identityPart } from './scope.mjs'

const READ_ACTIONS=new Set(['get_login_info','get_status','get_group_list','get_friend_list','get_group_msg_history','get_friend_msg_history','get_msg','get_forward_msg','get_group_member_info','get_group_info','get_image','get_record','get_file','get_group_file_url','get_private_file_url'])
const WRITE_ACTIONS=new Set(['send_group_msg','send_private_msg','upload_group_file','upload_private_file'])
function equal(a,b){return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest())}
function numberId(value){const text=identityPart(value);if(!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text)))throw Error('QQ 编号无效');return Number(text)}
export function oneBotText(segments) {
  return segments.map(s=>s.type==='text'?String(s.data?.text??''):s.type==='at'?'[@'+String(s.data?.qq??'')+']':s.type==='reply'?'[引用 #'+String(s.data?.id??'')+']':'['+s.type+']').join('')
}

export class SnowLuma {
  constructor({endpoint='http://127.0.0.1:3000',token,account,eventToken,eventSecret,timeoutMs=30000,fetchImpl=fetch}={}) {
    const url=new URL(endpoint)
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('QQ 接入地址无效')
    // Endpoint comes only from operator configuration, never from model arguments.
    if(typeof token!=='string'||token.length<16||typeof eventToken!=='string'||eventToken.length<24)throw Error('QQ 接口和上报均需独立配置足够长的密钥')
    this.endpoint=url.href.replace(/\/$/,'');this.token=token;this.account=identityPart(account,'机器人账号');numberId(account)
    this.eventToken=eventToken;this.eventSecret=eventSecret;this.timeoutMs=timeoutMs;this.fetch=fetchImpl
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw Error('QQ 接口超时无效')
  }
  authorizedEvent(headers,bytes) {
    const bearer=String(headers.authorization??'').replace(/^Bearer /,'')
    if(!equal(bearer,this.eventToken))return false
    if(this.eventSecret){const signature='sha1='+createHmac('sha1',this.eventSecret).update(bytes).digest('hex');if(!equal(String(headers['x-signature']??''),signature))return false}
    return true
  }
  async call(action,params,signal,{write=false}={}) {
    if(!READ_ACTIONS.has(action)&&!(write&&WRITE_ACTIONS.has(action)))throw Error('QQ 动作未获授权')
    const body=JSON.stringify(params??{}),timeout=AbortSignal.timeout(this.timeoutMs)
    const response=await this.fetch(this.endpoint+'/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.token},body,signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'})
    if(!response.ok)throw Error('QQ 接口 HTTP '+response.status)
    const declared=Number(response.headers.get('content-length')??0)
    if(declared>4*1024*1024){await response.body?.cancel();throw Error('QQ 接口结果过大')}
    let size=0;const parts=[]
    for await(const part of response.body){size+=part.length;if(size>4*1024*1024){throw Error('QQ 接口结果过大')}parts.push(part)}
    const result=JSON.parse(Buffer.concat(parts).toString())
    if(result.retcode!==0||result.status!=='ok'){
      const e=Error('QQ 动作失败 ('+String(result.retcode)+')：'+String(result.wording??result.message??'').slice(0,150))
      // A valid explicit failure envelope is retryable; a timeout is uncertain.
      e.definitelyNotSent=true;throw e
    }
    return result.data
  }
  async health(signal) {
    const login=await this.call('get_login_info',{},signal)
    if(String(login?.user_id)!==this.account)throw Error('QQ 登录账号与配置不一致，停止接收和发送')
    return {connected:true,account:this.account,nickname:String(login.nickname??'').slice(0,100)}
  }
  ingest(social,raw,{historical=false}={}) {
    if(!raw||String(raw.self_id)!==this.account)throw Error('QQ 上报账号不匹配')
    if(raw.post_type==='notice'&&['group_decrease','friend_recall','group_recall'].includes(raw.notice_type)) {
      if(raw.notice_type==='group_decrease'&&String(raw.user_id)===this.account){const t=social.discover({platform:'qq',account:this.account,kind:'group',peer:raw.group_id});social.approve(t.handle,false)}
      return {notice:true}
    }
    if(raw.post_type!=='message'||!['private','group'].includes(raw.message_type))return {ignored:true}
    const sender=identityPart(raw.user_id);if(sender===this.account)return {self:true}
    const segments=Array.isArray(raw.message)?raw.message.filter(s=>s&&typeof s.type==='string'&&s.data&&typeof s.data==='object').map(s=>({type:s.type,data:s.data})): [{type:'text',data:{text:String(raw.raw_message??raw.message??'')}}]
    const target=social.discover({platform:'qq',account:this.account,kind:raw.message_type,peer:raw.message_type==='group'?raw.group_id:raw.user_id,label:raw.message_type==='group'?String(raw.group_name??''):String(raw.sender?.nickname??'')})
    const result=social.ingest({target:target.handle,sender,externalId:raw.message_id,text:oneBotText(segments),segments,mentioned:!historical&&segments.some(s=>s.type==='at'&&String(s.data.qq)===this.account),receivedAt:Number.isSafeInteger(raw.time)&&raw.time>0?raw.time*1000:Date.now()})
    if(historical&&result.inserted)social.db.prepare('UPDATE yoyo_events SET read_at=? WHERE id=?').run(Date.now(),result.id)
    return {...result,target:target.handle,approved:!!target.approved}
  }
  async history(social,handle,{anchor=0,count=20}={},signal) {
    const t=social.target(handle,{approved:true})
    if(t.platform!=='qq'||t.account!==this.account||!Number.isInteger(count)||count<1||count>50||!Number.isSafeInteger(anchor))throw Error('QQ 历史请求无效')
    const action=t.kind==='group'?'get_group_msg_history':'get_friend_msg_history'
    const data=await this.call(action,{[t.kind==='group'?'group_id':'user_id']:numberId(t.peer),message_id:anchor,count,reverse_order:true},signal)
    const rows=data?.messages;if(!Array.isArray(rows)||rows.length>100)throw Error('QQ 历史格式无效')
    let added=0
    for(const raw of rows){const peer=t.kind==='group'?raw.group_id:raw.user_id;if(String(peer)!==t.peer)throw Error('QQ 历史返回了其他聊天的数据');const r=this.ingest(social,{...raw,post_type:'message',message_type:t.kind,self_id:this.account},{historical:true});if(r.inserted)added++}
    return {added,count:rows.length}
  }
  async discoverWindows(social,signal){
    await this.health(signal)
    const groups=await this.call('get_group_list',{},signal),friends=await this.call('get_friend_list',{},signal)
    if(!Array.isArray(groups)||!Array.isArray(friends)||groups.length+friends.length>10000)throw Error('QQ 通讯录格式或数量无效')
    for(const g of groups)social.discover({platform:'qq',account:this.account,kind:'group',peer:numberId(g.group_id),label:String(g.group_name??'')})
    for(const f of friends)social.discover({platform:'qq',account:this.account,kind:'private',peer:numberId(f.user_id),label:String(f.remark||f.nickname||'')})
    return {groups:groups.length,friends:friends.length,approvedAutomatically:false}
  }
  async sendAsset(target,content,bytes,signal,authorize=()=>{}) {
    if(target.platform!=='qq'||target.account!==this.account||!Buffer.isBuffer(bytes)||bytes.length!==content.bytes||bytes.length>8*1024*1024||createHash('sha256').update(bytes).digest('hex')!==content.sha256)throw Error('QQ 附件或发件账号校验失败')
    await this.health(signal);authorize()
    const group=target.kind==='group',peer={[group?'group_id':'user_id']:numberId(target.peer)},file='base64://'+bytes.toString('base64')
    if(content.kind==='image'){
      const data=await this.call(group?'send_group_msg':'send_private_msg',{...peer,message:[{type:'image',data:{file}}]},signal,{write:true})
      return {messageId:data?.message_id??null}
    }
    const data=await this.call(group?'upload_group_file':'upload_private_file',{...peer,file,name:content.name,upload_file:true},signal,{write:true})
    return {messageId:data?.file_id?'file:'+data.file_id:null}
  }
  async send(target,text,key,signal,authorize=()=>{}) {
    if(target.platform!=='qq'||target.account!==this.account)throw Error('QQ 发件账号不匹配')
    await this.health(signal)
    authorize()
    const group=target.kind==='group'
    const data=await this.call(group?'send_group_msg':'send_private_msg',{[group?'group_id':'user_id']:numberId(target.peer),message:[{type:'text',data:{text}}],auto_escape:true},signal,{write:true})
    return {messageId:data?.message_id??null}
  }
}
