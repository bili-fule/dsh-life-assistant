import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync, existsSync } from 'node:fs'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { chromium } from 'playwright-core'

export function workspacePath(root,value='.') {
  const p=resolve(root,value),rel=relative(resolve(root),p)
  if(rel.startsWith('..')||isAbsolute(rel))throw Error('路径必须在助理工作目录内')
  let parent=p
  while(!existsSync(parent)){const next=resolve(parent,'..');if(next===parent)break;parent=next}
  const actual=realpathSync(parent),realRoot=realpathSync(root),actualRel=relative(realRoot,actual)
  if(actualRel.startsWith('..')||isAbsolute(actualRel))throw Error('不允许通过符号链接离开工作目录')
  return p
}

export async function processRun(command,args,{cwd,timeout=30000,signal,env,maxOutput=32000}={}) {
  return new Promise((yes,no)=>{
    const child=spawn(command,args,{cwd,env:env??process.env,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='',timedOut=false,settled=false
    const kill=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL')}catch{}}
    const timer=setTimeout(()=>{timedOut=true;kill()},timeout)
    const abort=()=>kill();signal?.addEventListener('abort',abort,{once:true})
    child.stdout.on('data',b=>{if(stdout.length<maxOutput)stdout+=b.toString('utf8').slice(0,maxOutput-stdout.length)})
    child.stderr.on('data',b=>{if(stderr.length<maxOutput)stderr+=b.toString('utf8').slice(0,maxOutput-stderr.length)})
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
    child.once('error',e=>{if(settled)return;settled=true;cleanup();no(e)})
    child.once('close',(code,termination)=>{if(settled)return;settled=true;cleanup();kill();yes({exitCode:code,signal:termination,timedOut,stdout,stderr,outputMayBeTruncated:stdout.length>=maxOutput||stderr.length>=maxOutput})})
    if(signal?.aborted)kill()
  })
}

export function httpURL(value) {const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('只支持不含登录凭据的 HTTP/HTTPS 链接');return u}
export async function boundedDownload(url,{limit=30*1024*1024,signal,fetchImpl=fetch,media=false}={}) {
  let u=httpURL(url)
  for(let i=0;i<6;i++) {
    if(media && !(u.hostname==='weixin.qq.com'||u.hostname.endsWith('.weixin.qq.com')))throw Error('附件下载地址必须属于微信 CDN')
    const r=await fetchImpl(u,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)})
    if([301,302,303,307,308].includes(r.status)){const location=r.headers.get('location');await r.body?.cancel();if(!location)throw Error('重定向缺少地址');u=httpURL(new URL(location,u).href);continue}
    if(!r.ok)throw Error('下载失败 HTTP '+r.status)
    if(Number(r.headers.get('content-length')??0)>limit){await r.body?.cancel();throw Error('文件超出下载大小限制')}
    const parts=[];let total=0
    for await(const part of r.body){total+=part.length;if(total>limit)throw Error('文件超出下载大小限制');parts.push(part)}
    return {data:Buffer.concat(parts),type:r.headers.get('content-type')??'',url:u.href,status:r.status}
  }
  throw Error('链接重定向过多')
}

export class BrowserTools {
  constructor({workspace,signal,config={}}){this.workspace=resolve(workspace);mkdirSync(this.workspace,{recursive:true,mode:0o700});this.signal=signal;this.config=config;this.browserInstance=null;this.page=null}
  async browser(args) {
    clearTimeout(this.browserIdle)
    this.browserIdle=setTimeout(()=>this.stop().catch(()=>{}),120000);this.browserIdle.unref?.()
    if(!this.browserInstance){this.browserInstance=await chromium.launch({headless:true,executablePath:this.config.chromiumExecutable??process.env.DSH_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});const context=await this.browserInstance.newContext({viewport:{width:1280,height:900},acceptDownloads:false});this.page=await context.newPage();this.page.setDefaultTimeout(15000)}
    const p=this.page
    if(args.action==='goto')await p.goto(httpURL(args.url).href,{waitUntil:'domcontentloaded',timeout:30000})
    else if(args.action==='screenshot'){const dir=join(this.workspace,'screenshots');mkdirSync(dir,{recursive:true});const path=join(dir,'page-'+Date.now()+'.png');await p.screenshot({path,fullPage:false});return {path:relative(this.workspace,path),url:p.url()}}
    else if(args.action!=='snapshot') {
      if(typeof args.selector!=='string'||!/^\[data-dsh-life-id="\d+"\]$/.test(args.selector))throw Error('请使用最近页面快照返回的控件 selector')
      const target=p.locator(args.selector)
      if(args.action==='click')await target.click()
      else if(args.action==='fill')await target.fill(String(args.value??''))
      else if(args.action==='press')await target.press(String(args.value??'Enter'))
      else if(args.action==='select')await target.selectOption(String(args.value))
      else throw Error('未知浏览器操作')
      await p.waitForLoadState('domcontentloaded').catch(()=>{})
    }
    const controls=await p.locator('a,button,input,textarea,select,[role="button"]').evaluateAll(nodes=>nodes.slice(0,120).map((n,i)=>{n.setAttribute('data-dsh-life-id',String(i));return {selector:'[data-dsh-life-id="'+i+'"]',tag:n.tagName.toLowerCase(),text:(n.innerText||n.getAttribute('aria-label')||n.getAttribute('placeholder')||'').slice(0,100),type:n.getAttribute('type'),href:n.getAttribute('href')}}))
    return {url:p.url(),title:await p.title(),text:(await p.locator('body').innerText()).slice(0,20000),controls}
  }
  async stop(){clearTimeout(this.browserIdle);await this.browserInstance?.close();this.browserInstance=null}
}
