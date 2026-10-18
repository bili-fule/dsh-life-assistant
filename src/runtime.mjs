import { createServer } from 'node:http'
import { readFileSync,mkdirSync,writeFileSync,existsSync,readdirSync,unlinkSync,chmodSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash,timingSafeEqual,randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import qrcode from 'qrcode-generator'
import { Store,messageKey } from './store.mjs'
import { Model } from './model.mjs'
import { command,applyAnalysis,schedule,deliverOne } from './assistant.mjs'
import { localParts,parseTime } from './time.mjs'
import * as ilink from './ilink.mjs'

export function safeBase(value) {
  const u=new URL(value)
  if(u.protocol!=='https:' || !(u.hostname==='ilinkai.weixin.qq.com'||u.hostname.endsWith('.ilinkai.weixin.qq.com')) || u.username||u.password||u.port) throw Error('拒绝非微信 iLink 服务地址')
  return u.origin
}
function digest(v) { return createHash('sha256').update(v).digest() }
function json(res,data,status=200) {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function body(req) {let bytes=0,parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>100000)throw Error('输入过长');parts.push(chunk)}return JSON.parse(Buffer.concat(parts).toString()||'{}')}
function svg(text) {const q=qrcode(0,'M');q.addData(text);q.make();return q.createSvgTag({cellSize:6,margin:24,scalable:true})}

export class Runtime {
  constructor(config={}) {
    this.config={host:'127.0.0.1',port:3180,provider:'xuanluo',model:'cn:deepseek-v4.1-flash',...config}
    this.stateDir=resolve(config.stateDir??process.env.DSH_LIFE_DATA??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'life-assistant'))
    mkdirSync(this.stateDir,{recursive:true,mode:0o700})
    this.store=new Store(join(this.stateDir,'assistant.sqlite'))
    this.abort=new AbortController()
    this.model=new Model(config.llm,{...this.config,stopSignal:this.abort.signal})
    this.running=false;this.working=null;this.polling=null;this.login=null;this.pollGeneration=0
    const tokenPath=join(this.stateDir,'admin-token')
    if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{mode:0o600})
    this.adminToken=process.env.DSH_LIFE_ADMIN_TOKEN??readFileSync(tokenPath,'utf8').trim()
    if(this.adminToken.length<24)throw Error('管理密钥至少需要 24 个字符')
  }
  async start() {
    this.running=true
    this.server=createServer((req,res)=>this.http(req,res).catch(()=>{if(!res.headersSent)json(res,{error:'操作未完成，请检查输入或查看状态'},400);else res.end()}))
    await new Promise((yes,no)=>{this.server.once('error',no);this.server.listen(this.config.port,this.config.host,yes)})
    this.timer=setInterval(()=>{if(!this.working)this.working=this.tick().catch(e=>this.log('worker.error',e)).finally(()=>{this.working=null})},2000)
    this.working=this.tick().catch(e=>this.log('worker.error',e)).finally(()=>{this.working=null})
    this.startPolling()
    console.log(`[life-assistant] ready on ${this.config.host}:${this.config.port}; private data outside plugin source`)
  }
  log(action,error) {this.store.audit(action,{message:String(error?.message??error).slice(0,300)})}
  status() {
    const c=this.store.get('wechat')
    return {bound:!!c?.token,ownerBound:!!this.store.get('owner'),login:this.login?{status:this.login.status,message:this.login.message}:null,
      provider:this.config.provider,model:this.config.model,timezone:'Asia/Shanghai',
      persona:this.store.get('persona','你是一位贴心但不啰嗦的中文事务助理，说话自然，判断谨慎，帮用户把事情理清楚。'),
      styleLearning:this.store.get('style_learning',true),learnedStyle:this.store.get('learned_style',{}),styleCounts:this.store.get('style_counts',{}),
      quiet:this.store.get('quiet',{start:22,end:8}),digestHour:this.store.get('digest_hour',9),deliveryError:this.store.get('delivery_error'),pollError:this.store.get('poll_error'),lastInbound:this.store.get('last_inbound'),modelHealth:this.store.get('model_health')}
  }
  async http(req,res) {
    const url=new URL(req.url,'http://localhost')
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY')
    res.setHeader('content-security-policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
    if(req.method==='GET' && url.pathname==='/health')return json(res,{ok:true,service:'dsh-life-assistant'})
    const assets={'/':['../public/index.html','text/html; charset=utf-8'],'/app.js':['../public/app.js','text/javascript; charset=utf-8'],'/app.css':['../public/app.css','text/css; charset=utf-8']}
    if(req.method==='GET' && assets[url.pathname]) {const [file,type]=assets[url.pathname];res.writeHead(200,{'content-type':type,'cache-control':'no-store'});return res.end(readFileSync(new URL(file,import.meta.url)))}
    const token=String(req.headers.authorization??'').replace(/^Bearer /,'')
    if(!timingSafeEqual(digest(token),digest(this.adminToken)))return json(res,{error:'请输入管理密钥'},401)
    if(req.method==='GET' && url.pathname==='/api/state')return json(res,{...this.status(),...this.store.snapshot()})
    if(req.method==='GET' && url.pathname==='/api/qr.svg') {if(!this.login?.qrUrl)return json(res,{error:'请先发起绑定'},404);res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'});return res.end(svg(this.login.qrUrl))}
    if(req.method==='GET' && url.pathname==='/api/export') {res.setHeader('content-disposition','attachment; filename="life-assistant-export.json"');return json(res,{exportedAt:new Date().toISOString(),...this.store.snapshot(),settings:{persona:this.store.get('persona'),learnedStyle:this.store.get('learned_style',{})}})}
    if(req.method!=='POST')return json(res,{error:'没有这个操作'},404)
    const data=await body(req)
    if(url.pathname==='/api/login') {await this.beginLogin();return json(res,{ok:true})}
    if(url.pathname==='/api/verify') {if(!this.login||this.login.status!=='need_verifycode')throw Error('当前不需要验证码');if(!/^\d{4,12}$/.test(String(data.code)))throw Error('验证码应为数字');this.login.verifyCode=String(data.code);this.login.status='wait';this.runLogin(this.login);return json(res,{ok:true})}
    if(url.pathname==='/api/unbind') {this.pollGeneration++;this.store.set('wechat',null);this.store.set('owner',null);this.store.set('context_token',null);this.login=null;this.store.audit('wechat.unbind',{});return json(res,{ok:true})}
    if(url.pathname==='/api/settings') {
      if(typeof data.persona==='string')this.store.set('persona',data.persona.slice(0,2000))
      if(typeof data.styleLearning==='boolean')this.store.set('style_learning',data.styleLearning)
      if(data.resetStyle===true){this.store.set('style_counts',{});this.store.set('learned_style',{})}
      if(data.quiet && [data.quiet.start,data.quiet.end].every(v=>Number.isInteger(v)&&v>=0&&v<=23))this.store.set('quiet',data.quiet)
      if(data.digestHour===null||(Number.isInteger(data.digestHour)&&data.digestHour>=0&&data.digestHour<=23))this.store.set('digest_hour',data.digestHour)
      this.store.audit('settings.update',{fields:Object.keys(data)});return json(res,{ok:true})
    }
    if(url.pathname==='/api/inbox') {if(typeof data.text!=='string'||!data.text.trim()||data.text.length>20000)throw Error('请输入 1 至 20000 字');const owner=this.store.get('owner')??'admin';this.store.ingest('admin:'+randomBytes(12).toString('hex'),owner,data.text.trim());return json(res,{ok:true})}
    if(url.pathname==='/api/preview') {
      if(typeof data.text!=='string'||!data.text.trim()||data.text.length>20000)throw Error('请输入 1 至 20000 字')
      if(this.working)return json(res,{error:'正在处理其他消息，请稍后再试'},409)
      this.working=this.model.analyze(data.text,this.store).finally(()=>{this.working=null})
      try {const analysis=await this.working;this.store.set('model_health',{ok:true,at:Date.now()});return json(res,analysis)}
      catch(e){this.store.set('model_health',{ok:false,at:Date.now(),message:'模型预览未成功'});this.log('model.preview.error',e);return json(res,{error:'模型调用未成功，原有事务未改动'},502)}
    }
    if(url.pathname==='/api/task') {const patch={};if(['open','confirm','waiting','done','cancelled'].includes(data.status))patch.status=data.status;if(Object.hasOwn(data,'remindAt'))patch.remind_at=parseTime(data.remindAt);if(Object.hasOwn(data,'dueAt'))patch.due_at=parseTime(data.dueAt);if(!Number.isInteger(data.id))throw Error('编号无效');return json(res,this.store.updateTask(data.id,patch))}
    if(url.pathname==='/api/forget') {if(!Number.isInteger(data.id))throw Error('编号无效');this.store.forget(data.id);return json(res,{ok:true})}
    if(url.pathname==='/api/retry') {if(!Number.isInteger(data.id))throw Error('编号无效');this.store.db.prepare("UPDATE inbox SET state='pending',attempts=0,next_at=0,error=NULL WHERE id=? AND state='failed'").run(data.id);return json(res,{ok:true})}
    if(url.pathname==='/api/compact') {if(this.working)return json(res,{error:'正在处理消息，请稍后再试'},409);this.working=this.model.compact(this.store,{force:true}).finally(()=>{this.working=null});return json(res,{ok:await this.working})}
    if(url.pathname==='/api/backup') {this.backup();return json(res,{ok:true})}
    return json(res,{error:'没有这个操作'},404)
  }
  async beginLogin() {
    if(this.store.get('wechat')?.token)throw Error('已绑定微信，请先解绑再绑定其他账号')
    if(this.login && ['wait','scaned'].includes(this.login.status))return
    const qr=await ilink.fetchQRCode()
    if(!qr.qrcode||!qr.qrcode_img_content)throw Error('微信未返回二维码')
    this.login={status:'wait',message:'请用微信扫码，随后按手机提示完成配对。',qrcode:qr.qrcode,qrUrl:qr.qrcode_img_content,base:ilink.DEFAULT_BASE_URL,started:Date.now()}
    this.runLogin(this.login)
  }
  runLogin(login) {if(login.polling)return;login.polling=true;this.loginLoop(login).catch(e=>{login.status='error';login.message='微信绑定失败，请重试';this.log('wechat.login.error',e)}).finally(()=>{login.polling=false})}
  async loginLoop(login) {
    while(this.running && this.login===login && Date.now()-login.started<300000) {
      const r=await ilink.pollQRStatus({baseUrl:login.base,qrcode:login.qrcode,verifyCode:login.verifyCode})
      if(this.login!==login||!this.running)return
      login.status=r.status
      if(r.status==='confirmed') {
        if(!(r.bot_token??r.token)||!r.ilink_user_id)throw Error('微信绑定缺少用户或令牌')
        const c={token:r.bot_token??r.token,base:safeBase(r.baseurl??login.base),botId:r.ilink_bot_id}
        this.store.transaction(()=>{this.store.set('wechat',c);this.store.set('owner',r.ilink_user_id);this.store.set('cursor','');this.store.set('context_token',null);this.store.audit('wechat.bound',{})})
        login.message='微信已连接，给机器人发一条消息即可开始。';this.startPolling();return
      }
      if(r.status==='need_verifycode'){login.message='请将手机微信显示的数字配对码填入管理页。';login.verifyCode=undefined;return}
      if(r.status==='scaned_but_redirect'&&r.redirect_host)login.base=safeBase('https://'+r.redirect_host)
      if(['expired','verify_code_blocked','binded_redirect'].includes(r.status)){login.message='二维码已失效或绑定冲突，请重新发起绑定。';return}
      if(r.status==='scaned'){login.message='已扫码，等待微信确认。';login.verifyCode=undefined}
      await delay(1000,undefined,{signal:this.abort.signal})
    }
    login.status='expired';login.message='二维码过期，请重新发起绑定。'
  }
  startPolling() {
    if(this.polling||!this.store.get('wechat')?.token)return
    const generation=++this.pollGeneration
    this.polling=this.pollLoop(generation).catch(e=>{if(this.running)this.log('wechat.poll.error',e)}).finally(()=>{this.polling=null;if(this.running&&this.store.get('wechat')?.token)this.startPolling()})
  }
  async pollLoop(generation) {
    let failures=0
    while(this.running&&generation===this.pollGeneration) {
      const c=this.store.get('wechat');if(!c?.token)return
      try {
        const result=await ilink.getUpdates({baseUrl:safeBase(c.base),token:c.token,buf:this.store.get('cursor',''),signal:this.abort.signal})
        if(!this.running||generation!==this.pollGeneration)return
        if((result.ret??result.errcode??0)!==0)throw Error(`微信拉取失败 (${result.ret??result.errcode})`)
        const owner=this.store.get('owner')
        // Cursor and durable inbox commit together; a crash cannot acknowledge a lost message.
        this.store.transaction(()=>{
          for(const raw of result.msgs??[]) {
            if(raw.from_user_id!==owner || (raw.message_type!=null&&raw.message_type!==1))continue
            const text=(raw.item_list??[]).map(i=>i.type===1?i.text_item?.text:i.type===3?i.voice_item?.text:'').filter(Boolean).join('\n')
            if(raw.context_token){this.store.set('context_token',raw.context_token);this.store.set('last_inbound',Date.now());this.store.db.prepare("UPDATE outbox SET next_at=0 WHERE state='pending'").run()}
            if(text.trim())this.store.ingest(messageKey(raw),owner,text.slice(0,20000))
            else this.store.enqueue('unsupported:'+messageKey(raw),'reply','这条内容没有可读取的文字。目前支持文字和微信已转写的语音；图片、文件和合并转发请复制文字后再发，我不会假装已经读懂。')
          }
          if(result.get_updates_buf!=null)this.store.set('cursor',result.get_updates_buf)
          this.store.set('poll_error',null)
        })
        failures=0
        await delay(350,undefined,{signal:this.abort.signal})
      } catch(e) {
        if(!this.running)return
        failures++;this.store.set('poll_error',{message:'微信连接暂时不可用，正在重连。',at:Date.now()})
        if(failures===1||failures%10===0)this.log('wechat.poll.retry',e)
        await delay(Math.min(60000,1000*2**Math.min(failures,6)),undefined,{signal:this.abort.signal})
      }
    }
  }
  async tick() {
    if(!this.running)return
    const row=this.store.nextMessage()
    if(row) {
      this.store.db.prepare("UPDATE inbox SET state='processing' WHERE id=?").run(row.id)
      try {
        if(/^(?:\/status|状态)$/u.test(row.text.trim())) this.finishCommand(row,JSON.stringify(this.status(),null,2))
        else {
          const result=this.store.transaction(()=>{
            const reply=command(row.text,this.store,row.id)
            if(reply!==null)this.finishCommand(row,reply)
            return reply
          })
          if(result===null) {const analysis=await this.model.analyze(row.text,this.store);applyAnalysis(this.store,row,analysis);this.store.set('model_health',{ok:true,at:Date.now()})}
        }
      } catch(e) {
        const attempts=row.attempts+1,failed=attempts>=3
        this.store.transaction(()=>{
          this.store.db.prepare('UPDATE inbox SET state=?,attempts=?,next_at=?,error=? WHERE id=?').run(failed?'failed':'pending',attempts,Date.now()+30000*attempts,String(e.message).slice(0,300),row.id)
          this.store.set('model_health',{ok:false,at:Date.now(),message:'消息分析未完成，原文已保留。'})
          if(failed)this.store.enqueue('failed:'+row.id,'reply',`原文 #${row.id} 已保存，但暂时没能完成分析；没有据此新增待办。可在管理页重试。`)
        })
      }
    }
    schedule(this.store)
    if(this.store.get('wechat')?.token&&this.store.get('context_token'))await deliverOne(this.store,(text,key)=>this.send(text,key))
    const date=localParts().date
    if(this.store.get('backup_date')!==date){this.backup();this.store.set('backup_date',date)}
    if(!this.store.nextMessage() && Date.now()-(this.store.get('last_compaction_attempt',0))>60000) {
      this.store.set('last_compaction_attempt',Date.now())
      try {await this.model.compact(this.store)} catch(e){this.log('context.compact.retry',e)}
    }
  }
  finishCommand(row,reply) {this.store.db.prepare("UPDATE inbox SET state='done',result=?,error=NULL WHERE id=?").run(JSON.stringify({reply}),row.id);this.store.enqueue('reply:'+row.id,'reply',reply)}
  async send(text,key) {
    const c=this.store.get('wechat'),to=this.store.get('owner'),contextToken=this.store.get('context_token')
    if(!c?.token||!to||!contextToken)throw Error('微信尚未建立可用会话')
    const parts=[];for(let i=0;i<text.length;i+=1400)parts.push(text.slice(i,i+1400))
    for(let i=0;i<parts.length;i++) {
      const chunkKey=`sent-chunk:${key}:${i}`
      if(this.store.get(chunkKey))continue
      await ilink.sendMessage({baseUrl:safeBase(c.base),token:c.token,to,text:parts[i],contextToken,maxAttempts:1,clientId:'life-'+createHash('sha256').update(chunkKey).digest('hex').slice(0,32)})
      this.store.set(chunkKey,true)
    }
  }
  backup() {
    const dir=join(this.stateDir,'backups');mkdirSync(dir,{recursive:true,mode:0o700})
    const file=join(dir,'assistant-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite')
    this.store.db.exec("VACUUM INTO '"+file.replaceAll("'","''")+"'")
    chmodSync(file,0o600)
    const files=readdirSync(dir).filter(f=>/^assistant-[\dTZ-]+\.sqlite$/.test(f)).sort()
    for(const old of files.slice(0,-7))unlinkSync(join(dir,old))
    this.store.audit('backup.created',{})
  }
  async stop() {
    this.running=false;this.abort.abort();clearInterval(this.timer);this.pollGeneration++
    if(this.server)await new Promise(r=>this.server.close(r))
    await this.working?.catch(()=>{});await this.polling?.catch(()=>{})
    // Login polling is bounded and never mutates the store after running=false.
    this.store.close()
  }
}
