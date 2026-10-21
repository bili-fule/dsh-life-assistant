import { createServer } from 'node:http'
import { readFileSync,createReadStream,statSync,mkdirSync,writeFileSync,existsSync,readdirSync,unlinkSync,chmodSync } from 'node:fs'
import { join,resolve,relative,basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash,timingSafeEqual,randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import qrcode from 'qrcode-generator'
import { Ledger } from './ledger.mjs'
import { Store,messageKey } from './store.mjs'
import { NativeAgent } from './native-agent.mjs'
import { command,applyAnalysis,schedule,deliverOne } from './assistant.mjs'
import { Batcher } from './batching.mjs'
import { localParts,parseTime } from './time.mjs'
import * as ilink from './ilink.mjs'
import { Media,inboundLabel,safeFilename } from './media.mjs'
import { BrowserTools,workspacePath } from './tools.mjs'
import { communicationState,forgetCommunication,resetCommunication } from './communication.mjs'
import { Maintenance } from './maintenance.mjs'
import { markdownChunks } from './markdown.mjs'
import { SocialAgent } from './social-agent.mjs'

export function safeBase(value) {
  const u=new URL(value)
  if(u.protocol!=='https:' || !(u.hostname==='ilinkai.weixin.qq.com'||u.hostname.endsWith('.ilinkai.weixin.qq.com')) || u.username||u.password||u.port) throw Error('拒绝非微信 iLink 服务地址')
  return u.origin
}
function digest(v) { return createHash('sha256').update(v).digest() }
function json(res,data,status=200) {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function body(req,maxBytes=100000) {let bytes=0,parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>maxBytes)throw Error('输入过长');parts.push(chunk)}return JSON.parse(Buffer.concat(parts).toString()||'{}')}
function svg(text) {const q=qrcode(0,'M');q.addData(text);q.make();return q.createSvgTag({cellSize:6,margin:24,scalable:true})}

export class Runtime {
  constructor(config={}) {
    this.config={host:'127.0.0.1',port:3180,provider:'xuanluo',model:'cn:deepseek-v4.1-flash',...config}
    this.stateDir=resolve(config.stateDir??process.env.DSH_LIFE_DATA??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'life-assistant'))
    mkdirSync(this.stateDir,{recursive:true,mode:0o700})
    this.store=new Store(join(this.stateDir,'assistant.sqlite'))
    this.ledger=new Ledger(this.store)
    this.ledgerLoginAttempts=new Map()
    this.batcher=new Batcher(this.store,config)
    this.abort=new AbortController()
    this.workspace=resolve(config.workspace??join(this.stateDir,'workspace'))
    this.media=new Media({store:this.store,workspace:this.workspace,attachments:config.attachments,signal:this.abort.signal,config})
    this.tools=new BrowserTools({workspace:this.workspace,signal:this.abort.signal,config})
    this.model=config.agentDriver??new NativeAgent(config.nativeContext,this,this.config)
    this.autonomy=new SocialAgent(this,config.nativeContext,{separateSession:true,...config.autonomy})
    this.maintenance=new Maintenance(this,config)
    this.running=false;this.working=null;this.polling=null;this.login=null;this.pollGeneration=0
    const tokenPath=join(this.stateDir,'admin-token')
    if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{mode:0o600})
    this.adminToken=process.env.DSH_LIFE_ADMIN_TOKEN??readFileSync(tokenPath,'utf8').trim()
    if(this.adminToken.length<24)throw Error('管理密钥至少需要 24 个字符')
  }
  async start() {
    this.running=true
    this.store.db.prepare("UPDATE outbox SET state='superseded' WHERE state='pending' AND unique_key LIKE 'unsupported:%'").run()
    for(const wire of this.store.db.prepare('SELECT external_id,payload FROM wire_messages ORDER BY received_at').all()) {
      const raw=JSON.parse(wire.payload)
      if(raw.from_user_id===this.store.get('owner'))this.store.ingest(wire.external_id,raw.from_user_id,inboundLabel(raw),raw.create_time_ms??Date.now())
    }
    this.server=createServer((req,res)=>this.http(req,res).catch(()=>{if(!res.headersSent)json(res,{error:'操作未完成，请检查输入或查看状态'},400);else res.end()}))
    await new Promise((yes,no)=>{this.server.once('error',no);this.server.listen(this.config.port,this.config.host,yes)})
    this.timer=setInterval(()=>{if(!this.working)this.working=this.tick().catch(e=>this.log('worker.error',e)).finally(()=>{this.working=null})},500)
    this.deliveryTimer=setInterval(()=>{void this.deliveryTick().catch(e=>this.log('delivery.error',e))},500)
    this.working=this.tick().catch(e=>this.log('worker.error',e)).finally(()=>{this.working=null})
    this.startPolling()
    // Restore the existing private Agent after restart so its native UI remains usable before the next WeChat message.
    if(this.config.nativeContext&&this.model.sessionId)void this.model.ensure().catch(e=>this.log('native.restore.error',e))
    console.log(`[life-assistant] ready on ${this.config.host}:${this.config.port}; private data outside plugin source`)
  }
  log(action,error) {this.store.audit(action,{message:String(error?.message??error).slice(0,300)})}
  status() {
    const c=this.store.get('wechat')
    return {bound:!!c?.token,ownerBound:!!this.store.get('owner'),login:this.login?{status:this.login.status,message:this.login.message}:null,
      provider:this.config.provider,model:this.config.model,timezone:'Asia/Shanghai',engine:'DSH native Agent',nativeSessionId:this.store.get('native_session_id'),
      batching:{quietSeconds:this.batcher.quietMs/1000,maxWaitSeconds:this.batcher.maxWaitMs/1000,maxMessages:this.batcher.maxMessages},
      maintenance:this.maintenance.status(),markdown:true,communication:communicationState(this.store,{all:true}),contextPolicy:{configuredTriggerTokens:263000,declaredModelWindow:1000000,retainTokens:65536,summaryMaxTokens:8192},
      capabilities:{shell:!this.autonomy.enabled||this.autonomy.separate||!!this.autonomy.executor,links:true,browser:!this.autonomy.enabled||this.autonomy.separate,images:!!this.config.attachments,files:true,mergedArchives:true,fileSending:true,messageSending:true},workspaceFiles:this.workspaceFiles(),
      autonomy:{enabled:this.autonomy.enabled,usage:this.autonomy.data.db.prepare('SELECT steps,tokens FROM yoyo_usage WHERE day=?').get(localParts().date)??{steps:0,tokens:0},recentActivity:this.autonomy.data.db.prepare('SELECT state,body,created_at FROM yoyo_activity_log ORDER BY id DESC LIMIT 12').all().map(r=>({...r,body:JSON.parse(r.body)})),personaVersions:this.autonomy.data.db.prepare('SELECT id,body,created_at FROM yoyo_persona_versions ORDER BY id DESC LIMIT 5').all(),memoryMaintenance:this.autonomy.memoryMaintenance.status(),team:this.autonomy.team?this.autonomy.team.status():null,separateSession:this.autonomy.separate,sessionId:this.autonomy.sessionId,nativeReady:this.autonomy.nativeReady,...this.autonomy.data.snapshot(),persona:this.autonomy.store.get('yoyo_persona','你是 yoyo，说话自然，有自己的兴趣与打算，熟悉的人和陌生人有不同边界。'),self:this.autonomy.store.get('yoyo_self',{mood:'calm',energy:'steady'}),plans:this.autonomy.store.db.prepare('SELECT id,title,progress,state,not_before,scopes FROM yoyo_plans ORDER BY updated_at DESC LIMIT 30').all(),settings:this.autonomy.store.get('yoyo_settings',{observeOnly:true,paused:false,dailySteps:0}),qqConfigured:!!this.autonomy.qq,browserConfigured:!!this.autonomy.config.publicBrowser},
      persona:this.store.get('persona','你是一位贴心但不啰嗦的中文事务助理，说话自然，判断谨慎，帮用户把事情理清楚。'),
      styleLearning:this.store.get('style_learning',true),learnedStyle:this.store.get('learned_style',{}),styleCounts:this.store.get('style_counts',{}),
      quiet:this.store.get('quiet',{start:22,end:8}),digestHour:this.store.get('digest_hour',9),deliveryError:this.store.get('delivery_error'),pollError:this.store.get('poll_error'),lastInbound:this.store.get('last_inbound'),modelHealth:this.store.get('model_health')}
  }
  async ledgerHttp(req,res,url){
    const path=url.pathname,token=String(req.headers.cookie??'').match(/(?:^|;\s*)ledger_session=([a-f0-9]{64})(?:;|$)/)?.[1]
    const admin=timingSafeEqual(digest(String(req.headers.authorization??'').replace(/^Bearer /,'')),digest(this.adminToken))
    const authenticated=admin||this.ledger.authenticated(token)
    if(req.method==='GET'&&path==='/api/ledger/public')return json(res,this.ledger.publicSummary())
    if(req.method==='GET'&&path==='/api/ledger/session')return json(res,{authenticated})
    if(req.method==='POST'){
      if(!String(req.headers['content-type']??'').startsWith('application/json'))return json(res,{error:'需要 JSON 请求'},415)
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(res,{error:'请求来源不匹配'},403)
      if(path==='/api/ledger/login'){
        const now=Date.now(),key=req.socket.remoteAddress??'unknown'
        for(const [ip,r] of this.ledgerLoginAttempts)if(now-r.start>60000)this.ledgerLoginAttempts.delete(ip)
        const rate=this.ledgerLoginAttempts.get(key)??{start:now,count:0};rate.count++;this.ledgerLoginAttempts.set(key,rate)
        if(rate.count>10||this.ledgerLoginAttempts.size>1000)return json(res,{error:'尝试过多，请稍后再试'},429)
        const data=await body(req,2000),session=this.ledger.login(data.password)
        if(!session)return json(res,{error:'登录失败'},401)
        res.setHeader('set-cookie','ledger_session='+session+'; HttpOnly; Secure; SameSite=Strict; Path=/api/ledger/; Max-Age=604800')
        return json(res,{authenticated:true})
      }
      if(!authenticated)return json(res,{error:'请先登录'},401)
      if(path==='/api/ledger/logout'){this.ledger.logout(token);res.setHeader('set-cookie','ledger_session=; HttpOnly; Secure; SameSite=Strict; Path=/api/ledger/; Max-Age=0');return json(res,{ok:true})}
      if(path==='/api/ledger/amend')return json(res,this.ledger.amend(await body(req,10000)))
      if(admin&&path==='/api/ledger/settings'){
        const data=await body(req,2000)
        if(data.password!==undefined)this.ledger.setPassword(data.password)
        if(data.published!==undefined){if(typeof data.published!=='boolean')throw Error('公开开关无效');this.store.set('ledger_public_enabled',data.published)}
        return json(res,{ok:true})
      }
    }
    if(!authenticated)return json(res,{error:'请先登录'},401)
    if(req.method==='GET'&&path==='/api/ledger/details')return json(res,{currency:'CNY',unit:'cents',categories:this.ledger.categories(url.searchParams.get('month')??undefined),pending:this.ledger.pending(),months:this.ledger.summary(url.searchParams.get('month')??undefined),...this.ledger.list({month:url.searchParams.get('month')??undefined,after:Number(url.searchParams.get('after')??0),limit:50})})
    return json(res,{error:'没有这个操作'},404)
  }
  async http(req,res) {
    const url=new URL(req.url,'http://localhost')
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY')
    res.setHeader('content-security-policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
    if(req.method==='GET' && url.pathname==='/health')return json(res,{ok:true,service:'dsh-life-assistant'})
    if(req.method==='POST'&&url.pathname==='/onebot/event') {
      const qq=this.autonomy.qq;if(!qq)return json(res,{error:'QQ 未配置'},404)
      let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('消息过大');parts.push(chunk)}
      const bytes=Buffer.concat(parts);if(!qq.authorizedEvent(req.headers,bytes))return json(res,{error:'上报认证失败'},401)
      const event=JSON.parse(bytes.toString());qq.ingest(this.autonomy.data,event);return json(res,{ok:true})
    }
    if(url.pathname.startsWith('/api/ledger/'))return this.ledgerHttp(req,res,url)
    const assets={'/ledger/':['../public/ledger.html','text/html; charset=utf-8'],'/ledger.js':['../public/ledger.js','text/javascript; charset=utf-8'],'/ledger.css':['../public/ledger.css','text/css; charset=utf-8'],'/':['../public/index.html','text/html; charset=utf-8'],'/app.js':['../public/app.js','text/javascript; charset=utf-8'],'/app.css':['../public/app.css','text/css; charset=utf-8']}
    if(req.method==='GET' && assets[url.pathname]) {const [file,type]=assets[url.pathname];res.writeHead(200,{'content-type':type,'cache-control':'no-store'});return res.end(readFileSync(new URL(file,import.meta.url)))}
    const token=String(req.headers.authorization??'').replace(/^Bearer /,'')
    if(!timingSafeEqual(digest(token),digest(this.adminToken)))return json(res,{error:'请输入管理密钥'},401)
    if(req.method==='GET' && url.pathname==='/api/state')return json(res,{...this.status(),...this.store.snapshot()})
    if(req.method==='GET' && url.pathname==='/api/qr.svg') {if(!this.login?.qrUrl)return json(res,{error:'请先发起绑定'},404);res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'});return res.end(svg(this.login.qrUrl))}
    if(req.method==='GET' && url.pathname==='/api/export') {res.setHeader('content-disposition','attachment; filename="life-assistant-export.json"');return json(res,{exportedAt:new Date().toISOString(),...this.store.snapshot(),settings:{persona:this.store.get('persona'),learnedStyle:this.store.get('learned_style',{})}})}
    if(req.method==='GET' && url.pathname==='/api/asset') {const file=workspacePath(this.workspace,url.searchParams.get('path')??'');if(!statSync(file).isFile())throw Error('路径不是文件');res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(safeFilename(file))});return createReadStream(file).on('error',()=>res.destroy()).pipe(res)}
    if(req.method!=='POST')return json(res,{error:'没有这个操作'},404)
    const data=await body(req,url.pathname==='/api/upload'?44*1024*1024:100000)
    if(url.pathname==='/api/yoyo/settings') {
      const current=this.autonomy.store.get('yoyo_settings',{observeOnly:true,paused:false,dailySteps:0})
      if(Object.keys(data).some(k=>!['observeOnly','paused','dailySteps','persona'].includes(k)))throw Error('设置项无效')
      for(const k of ['observeOnly','paused'])if(k in data&&typeof data[k]!=='boolean')throw Error('开关设置无效')
      if('dailySteps' in data&&(!Number.isSafeInteger(data.dailySteps)||data.dailySteps<0||data.dailySteps>100000))throw Error('每日预算无效')
      if('persona' in data){if(typeof data.persona!=='string'||!data.persona.trim()||data.persona.length>2000)throw Error('人设无效');this.autonomy.store.set('yoyo_persona',data.persona);this.autonomy.data.db.prepare('INSERT INTO yoyo_persona_versions(body,created_at) VALUES(?,?)').run(data.persona,Date.now())}
      const {persona,...settings}=data;this.autonomy.store.set('yoyo_settings',{...current,...settings})
      if(data.observeOnly===true||data.paused===true)this.autonomy.data.db.prepare("UPDATE yoyo_outbox SET state='cancelled',error='已暂停发言' WHERE state IN ('queued','retry_wait') AND (?=1 OR target IN (SELECT handle FROM yoyo_targets WHERE platform='qq'))").run(data.paused===true?1:0)
      if(data.paused===true&&this.autonomy.sessionId){const result=await this.config.nativeContext?.sessionController.resolveAgent(this.autonomy.sessionId);result?.agent?.cancel({kind:'hook',reason:'用户暂停自主活动'})}
      return json(res,{ok:true})
    }
    if(url.pathname==='/api/yoyo/approve')return json(res,{target:this.autonomy.data.approve(data.target,data.approved)})
    if(url.pathname==='/api/yoyo/wake') {const target=data.target??'overview';if(!['overview','public'].includes(target))this.autonomy.data.target(target,{approved:true});this.autonomy.store.set('yoyo_next_focus',target);return json(res,{ok:true})}
    if(url.pathname==='/api/yoyo/qq-discover'){if(!this.autonomy.qq)throw Error('QQ 未配置');return json(res,await this.autonomy.qq.discoverWindows(this.autonomy.data,this.abort.signal))}
    if(url.pathname==='/api/yoyo/qq-check') {if(!this.autonomy.qq)throw Error('QQ 未配置');return json(res,await this.autonomy.qq.health(this.abort.signal))}
    if(url.pathname==='/api/yoyo/memory-retry')return json(res,this.autonomy.memoryMaintenance.retry(data.id))
    if(url.pathname==='/api/yoyo/forget')return json(res,{forgotten:this.autonomy.data.forget(data.id)})
    if(url.pathname==='/api/upload') {
      if(typeof data.data!=='string'||data.data.length>43*1024*1024)throw Error('文件过大')
      const bytes=Buffer.from(data.data,'base64');if(!bytes.length||bytes.length>32*1024*1024)throw Error('文件大小无效')
      const name=safeFilename(data.name),dir=join(this.workspace,'uploads');mkdirSync(dir,{recursive:true,mode:0o700})
      const path=join(dir,createHash('sha256').update(bytes).digest('hex').slice(0,12)+'-'+name);writeFileSync(path,bytes,{mode:0o600})
      const id='upload:'+randomBytes(16).toString('hex');this.store.ingest(id,this.store.get('owner')??'admin','[上传文件] '+name)
      const row=this.store.db.prepare('SELECT id FROM inbox WHERE external_id=?').get(id);this.store.setInputContext(row.id,{prepared:false,localFiles:[path]})
      return json(res,{ok:true,id:row.id})
    }
    if(url.pathname==='/api/login') {await this.beginLogin();return json(res,{ok:true})}
    if(url.pathname==='/api/verify') {if(!this.login||this.login.status!=='need_verifycode')throw Error('当前不需要验证码');if(!/^\d{4,12}$/.test(String(data.code)))throw Error('验证码应为数字');this.login.verifyCode=String(data.code);this.login.status='wait';this.runLogin(this.login);return json(res,{ok:true})}
    if(url.pathname==='/api/unbind') {this.pollGeneration++;this.store.set('wechat',null);this.store.set('owner',null);this.store.set('context_token',null);this.login=null;this.store.audit('wechat.unbind',{});return json(res,{ok:true})}
    if(url.pathname==='/api/settings') {
      if(typeof data.persona==='string')this.store.set('persona',data.persona.slice(0,2000))
      if(typeof data.styleLearning==='boolean')this.store.set('style_learning',data.styleLearning)
      if(data.resetStyle===true){this.store.set('style_counts',{});this.store.set('learned_style',{});resetCommunication(this.store)}
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
    if(url.pathname==='/api/forget-insight'){if(!Number.isInteger(data.id))throw Error('编号无效');forgetCommunication(this.store,data.id);return json(res,{ok:true})}
    if(url.pathname==='/api/forget') {if(!Number.isInteger(data.id))throw Error('编号无效');this.store.forget(data.id);return json(res,{ok:true})}
    if(url.pathname==='/api/retry') {if(!Number.isInteger(data.id))throw Error('编号无效');this.batcher.retry(data.id);return json(res,{ok:true})}
    if(url.pathname==='/api/compact') {if(this.working)return json(res,{error:'正在处理消息，请稍后再试'},409);this.working=this.model.compact().finally(()=>{this.working=null});return json(res,{ok:await this.working})}
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
            this.store.captureMessage(raw)
            const text=inboundLabel(raw)
            if(raw.context_token){this.store.set('context_token',raw.context_token);this.store.set('last_inbound',Date.now());this.store.db.prepare("UPDATE outbox SET next_at=0 WHERE state='pending'").run()}
            const inserted=this.store.ingest(messageKey(raw),owner,text.slice(0,30000))
            if(inserted&&this.maintenance.active)void this.model.interruptMaintenance?.().catch(e=>this.log('maintenance.interrupt',e))
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
    if(this.autonomy.enabled&&!this.autonomy.separate){
      await this.autonomy.tick();schedule(this.store);await this.deliveryTick()
      const date=localParts().date;if(this.store.get('backup_date')!==date){this.backup();this.store.set('backup_date',date)}
      const job=this.maintenance.next();if(job&&this.model.maintain&&!this.autonomy.store.get('yoyo_next_focus'))await this.maintenance.run(job)
      return
    }
    if(this.autonomy.enabled&&this.autonomy.separate){void this.socialTick()}
    const batch=this.batcher.ready(),row=batch?.[0]
    if(row) {
      this.batcher.claim(batch)
      this.activeBatch={anchor:row.id,sender:row.sender,waits:this.store.inputContext(row.id)?.nativeRequest?.waits??0}
      try {
        if(batch.length===1&&/^(?:\/status|状态)$/u.test(row.text.trim())) this.finishCommand(row,JSON.stringify(this.status(),null,2))
        else {
          const result=this.store.transaction(()=>{
            const reply=batch.length===1?command(row.text,this.store,row.id):null
            if(reply!==null)this.finishCommand(row,reply)
            return reply
          })
          if(result===null) {
            const prepared=await this.batcher.prepare(batch,this.media,this.workspace)
            const analysis=await this.model.analyze(prepared.text,this.store,Date.now(),{runner:this.tools,rowId:row.id,assets:prepared.assets,hasMedia:prepared.hasMedia,workspace:this.workspace,batchIds:batch.map(r=>r.id),directTexts:batch.map(r=>r.text)})
            applyAnalysis(this.store,row,analysis,{batchIds:this.batcher.members(row.id).map(r=>r.id)});this.store.set('model_health',{ok:true,at:Date.now()})
          }
        }
      } catch(e) {
        this.batcher.fail(this.batcher.members(row.id),e)
      } finally {this.activeBatch=null;this.store.set('conversation_finished_at',Date.now())}
    }
    schedule(this.store)
    await this.deliveryTick()
    const date=localParts().date
    if(this.store.get('backup_date')!==date){this.backup();this.store.set('backup_date',date)}
    const job=this.maintenance.next()
    if(job&&this.model.maintain)await this.maintenance.run(job)
  }
  async socialTick(){if(this.socialWorking)return;this.socialWorking=true;try{await this.autonomy.tick()}catch(e){this.log('social.tick',e)}finally{this.socialWorking=false}}
  async deliveryTick() {
    if(this.delivering)return this.delivering
    this.delivering=(async()=>{
      if(this.store.get('wechat')?.token&&this.store.get('context_token'))await deliverOne(this.store,(text,key,kind)=>this.send(text,key,kind))
      if(this.autonomy.enabled)await this.autonomy.deliver()
    })().finally(()=>{this.delivering=null})
    return this.delivering
  }

  async waitForMore(reason,signal) {
    const batch=this.activeBatch
    if(!batch)throw Error('只能在微信消息处理回合等待补充')
    if(typeof reason!=='string'||!reason.trim())throw Error('需要说明等待原因')
    if(batch.waits>=3)return {received:0,limitReached:true,message:'已等待三轮，请继续处理已有内容。'}
    batch.waits++
    const before=this.store.inputContext(batch.anchor)??{}
    this.store.setInputContext(batch.anchor,{...before,nativeRequest:{...before.nativeRequest,waits:batch.waits}})
    this.store.audit('inbox.agent_wait',{anchor:batch.anchor,reason:reason.slice(0,300),round:batch.waits})
    await delay(this.config.agentWaitMs??5000,undefined,{signal})
    signal.throwIfAborted()
    const rows=this.store.db.prepare("SELECT i.* FROM inbox i LEFT JOIN inbox_batch_members b ON b.inbox_id=i.id WHERE i.id>? AND i.state='pending' AND i.sender=? AND i.attempts=0 AND i.next_at<=? AND b.batch_id IS NULL ORDER BY i.id LIMIT ?").all(batch.anchor,batch.sender,Date.now(),this.batcher.maxMessages)
    if(!rows.length)return {received:0,message:'本次五秒等待没有新消息，继续已有任务。'}
    this.batcher.claim(rows,batch.anchor)
    const prepared=await this.batcher.prepare(rows,this.media,this.workspace)
    const context=this.store.inputContext(batch.anchor)??{},request=context.nativeRequest??{}
    this.store.setInputContext(batch.anchor,{...context,nativeRequest:{...request,batchIds:[...new Set([...(request.batchIds??[batch.anchor]),...rows.map(r=>r.id)])],directTexts:[...(request.directTexts??[]),...rows.map(r=>r.text)],hasMedia:request.hasMedia||prepared.hasMedia}})
    return {received:rows.length,text:prepared.text,assets:prepared.assets,messageIds:rows.map(r=>r.id)}
  }

  finishCommand(row,reply) {this.store.db.prepare("UPDATE inbox SET state='done',result=?,error=NULL WHERE id=?").run(JSON.stringify({reply}),row.id);this.store.enqueue('reply:'+row.id,'reply',reply)}
  workspaceFiles() {
    const files=[]
    const walk=(dir,depth=0)=>{if(depth>5||files.length>=150)return;for(const e of readdirSync(dir,{withFileTypes:true})){if(files.length>=150)break;const path=join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(path,depth+1);else if(e.isFile()){const s=statSync(path);files.push({name:e.name,path:relative(this.workspace,path),bytes:s.size,updatedAt:s.mtimeMs})}}}
    try{walk(this.workspace)}catch{}
    return files.sort((a,b)=>b.updatedAt-a.updatedAt)
  }
  enqueueMessage(text,key) {
    if(typeof text!=='string'||!text.trim()||text.length>20000)throw Error('微信消息应为 1 至 20000 字的非空文本')
    if(!this.store.get('wechat')?.token||!this.store.get('owner'))throw Error('请先绑定微信')
    this.store.enqueue('message:'+key,'reply',text.trim())
    return {queued:true,message:'文字已加入绑定微信发送队列，不代表已送达；平台拒收时保留重试，发送状态可在管理页查看。'}
  }
  enqueueFile(path,key) {
    if(statSync(path).size>20*1024*1024)throw Error('微信回传文件最大 20MiB')
    const hash=createHash('sha256').update(readFileSync(path)).digest('hex')
    this.store.enqueue('file:'+key,'file',JSON.stringify({path:relative(this.workspace,path),name:basename(path),hash}))
    return {queued:true,path:relative(this.workspace,path),message:'文件已加入微信发送队列，发送状态可在管理页查看。'}
  }
  async send(text,key,kind='reply',authorize=()=>{}) {
    const c=this.store.get('wechat'),to=this.store.get('owner'),contextToken=this.store.get('context_token')
    if(!c?.token||!to||!contextToken)throw Error('微信尚未建立可用会话')
    authorize()
    if(kind==='file') {
      const file=JSON.parse(text),path=workspacePath(this.workspace,file.path),data=readFileSync(path)
      if(createHash('sha256').update(data).digest('hex')!==file.hash)throw Error('待发送文件已变更，需要重新发送')
      let item=this.store.get('uploaded:'+key)
      if(!item){item=await ilink.uploadMedia({baseUrl:safeBase(c.base),token:c.token,to,data,name:file.name,image:/\.(png|jpe?g|webp|gif)$/i.test(file.name)});this.store.set('uploaded:'+key,item)}
      authorize();await ilink.sendMedia({baseUrl:safeBase(c.base),token:c.token,to,contextToken,item,clientId:'life-'+createHash('sha256').update(key).digest('hex').slice(0,32)})
      return
    }
    const parts=markdownChunks(text)
    for(let i=0;i<parts.length;i++) {
      const chunkKey=`sent-chunk:${key}:${i}`
      if(this.store.get(chunkKey))continue
      authorize()
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
    this.running=false;this.abort.abort();clearInterval(this.timer);clearInterval(this.deliveryTimer);this.pollGeneration++
    if(this.server)await new Promise(r=>this.server.close(r))
    await this.working?.catch(()=>{});await this.polling?.catch(()=>{});await this.delivering?.catch(()=>{})
    await this.autonomy.stop()
    this.model.stop?.()
    await this.tools.stop()
    // Login polling is bounded and never mutates the store after running=false.
    this.store.close()
  }
}
