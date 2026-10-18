import { mkdirSync,writeFileSync,readFileSync } from 'node:fs'
import { join,extname,basename,relative } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { XMLParser } from 'fast-xml-parser'
import { boundedDownload,processRun,workspacePath } from './tools.mjs'
import { parseAesKey,decryptAesEcb,sniffImageMime,CDN_BASE_URL } from './ilink.mjs'

const IMAGE=/\.(png|jpe?g|webp|gif)$/i
export function safeFilename(name) {return basename(String(name??'attachment.bin').replaceAll('\\','/')).replace(/[^\p{L}\p{N} ._()（）-]/gu,'_').slice(-180)||'attachment.bin'}
export function forwardedText(value) {
  if(typeof value!=='string')return ''
  if(!/<(?:msg|appmsg|recordinfo|recorditem)\b/i.test(value))return value
  if(/<!DOCTYPE|<!ENTITY/i.test(value))throw Error('聊天记录 XML 含不允许的实体声明')
  const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:true})
  const parts=[]
  const walk=(node,depth=0)=>{
    if(depth>15)return
    if(Array.isArray(node)){for(const child of node)walk(child,depth+1);return}
    if(!node||typeof node!=='object')return
    for(const [k,v] of Object.entries(node)) {
      if(['recordxml','recorditem'].includes(k)&&typeof v==='string'&&v.includes('<')){walk(parser.parse(v),depth+1);continue}
      if(['sourcename','sourcetime','datadesc','title','des','url','content','text'].includes(k)&&typeof v==='string')parts.push(v)
      else if(typeof v==='object')walk(v,depth+1)
    }
  }
  try{walk(parser.parse(value))}catch(e){throw Error('聊天记录 XML 解析失败：'+e.message)}
  return parts.length?'[合并转发资料]\n'+parts.join('\n'):value
}

export function inboundLabel(raw) {
  const parts=[]
  for(const item of raw.item_list??[]) {
    if(item.text_item?.text)parts.push(forwardedText(item.text_item.text))
    if(item.voice_item?.text)parts.push(item.voice_item.text)
    if(item.image_item)parts.push('[图片]')
    if(item.file_item)parts.push('[文件] '+safeFilename(item.file_item.file_name))
    if(item.video_item)parts.push('[视频]')
    if(item.ref_msg){const r=item.ref_msg.message_item??item.ref_msg;parts.push('[引用] '+inboundLabel({item_list:[r]}))}
  }
  if(raw.appmsg||raw.content)parts.push(forwardedText(raw.appmsg??raw.content))
  return parts.join('\n')||'[收到消息，内容待解析]'
}

export class Media {
  constructor({store,workspace,attachments,model,signal,config={}}) {this.store=store;this.workspace=workspace;this.attachments=attachments;this.model=model;this.signal=signal;this.config=config;mkdirSync(workspace,{recursive:true,mode:0o700})}
  async download(item,directory,index) {
    const data=item.image_item??item.file_item??item.voice_item??item.video_item
    const m=data?.media
    if(!m)throw Error('微信未下发该附件的下载信息')
    const url=m.full_url||`${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(m.encrypt_query_param??'')}`
    const response=await boundedDownload(url,{limit:32*1024*1024,signal:this.signal,media:true,fetchImpl:this.config.mediaFetch??fetch})
    const key=data.aeskey?Buffer.from(data.aeskey,'hex').toString('base64'):m.aes_key
    const bytes=key?decryptAesEcb(response.data,parseAesKey(key)):response.data
    if(data.md5&&createHash('md5').update(bytes).digest('hex')!==data.md5.toLowerCase())throw Error('微信附件 MD5 校验失败')
    const mime=sniffImageMime(bytes)
    const defaultName=item.image_item?`image-${index}.${mime.split('/')[1]}`:item.voice_item?`voice-${index}.silk`:item.video_item?`video-${index}.mp4`:'attachment.bin'
    const name=safeFilename(data.file_name??defaultName)
    const path=join(directory,createHash('sha256').update(bytes).digest('hex').slice(0,10)+'-'+name)
    writeFileSync(path,bytes,{mode:0o600})
    return {name,path,bytes:bytes.length}
  }
  async read(path,{depth=0,budget={count:0},assets=[],question}={}) {
    path=workspacePath(this.workspace,path)
    if(depth>3||++budget.count>24)return {text:'附件数量或层级超过本次读取预算；文件已保存，可继续用工具逐个读取。',assets}
    const name=basename(path)
    if(IMAGE.test(name)) {
      if(!this.attachments)throw Error('DSH 图片附件服务尚未启用')
      const bytes=readFileSync(path),ref=await this.attachments.saveImage({data:bytes,mediaType:sniffImageMime(bytes),name})
      const text=await this.model.describeImage(ref,question)
      assets.push({name,path:relative(this.workspace,path),kind:'image',attachment:ref})
      return {text:`[图片 ${name} 的识别结果]\n${text}`,assets}
    }
    const result=await processRun(this.config.python??'python3',[fileURLToPath(new URL('./extract.py',import.meta.url)),path],{cwd:this.workspace,signal:this.signal,timeout:90000,maxOutput:180000})
    if(result.exitCode!==0)throw Error('文件解析进程未完成：'+result.stderr.slice(0,200))
    let parsed
    try{parsed=JSON.parse(result.stdout)}catch{throw Error('文件解析结果无效')}
    assets.push({name,path:relative(this.workspace,path),kind:'file'})
    let text=`[文件 ${name}]\n${parsed.error?'读取提示：'+parsed.error:parsed.text}`
    if(parsed.truncated)text+='\n[正文超过本次预算，文件已完整保存，可以继续用工具读取。]'
    for(const child of parsed.children??[]) {
      if(budget.count>=24){text+='\n[其余附件已保存，需继续读取。]';break}
      try {const nested=await this.read(child,{depth:depth+1,budget,assets,question});text+='\n\n'+nested.text}
      catch(e){text+=`\n[附件 ${basename(child)} 读取未完成：${e.message}]`;assets.push({name:basename(child),path:relative(this.workspace,child),kind:'unread'})}
      if(text.length>48000){text=text.slice(0,48000)+'\n[本次正文达到预算，其余内容可通过 read_file 或 shell 继续读取。]';break}
    }
    return {text,assets}
  }
  async prepare(row) {
    const existing=this.store.inputContext(row.id)
    if(existing?.prepared)return existing
    if(existing?.localFiles) {
      const texts=[],assets=[]
      for(const path of existing.localFiles){const result=await this.read(path,{assets});texts.push(result.text)}
      const context={...existing,prepared:true,text:texts.join('\n\n'),assets,hasMedia:true,preparedAt:Date.now()};this.store.setInputContext(row.id,context);return context
    }
    const wire=this.store.db.prepare('SELECT payload FROM wire_messages WHERE external_id=?').get(row.external_id)
    if(!wire)return {prepared:true,text:forwardedText(row.text),assets:[]}
    const raw=JSON.parse(wire.payload),texts=[],assets=[]
    const dir=join(this.workspace,'inbox',createHash('sha256').update(row.external_id).digest('hex').slice(0,16));mkdirSync(dir,{recursive:true,mode:0o700})
    let index=0,hasMedia=false
    for(const item of raw.item_list??[]) {
      if(item.text_item?.text)texts.push(forwardedText(item.text_item.text))
      if(item.voice_item?.text)texts.push(item.voice_item.text)
      if(item.image_item||item.file_item||item.video_item||(item.voice_item&&!item.voice_item.text)) {
        hasMedia=true
        const file=await this.download(item,dir,++index)
        const parsed=await this.read(file.path,{assets});texts.push(parsed.text)
      }
      if(item.ref_msg)texts.push('[引用资料]\n'+inboundLabel({item_list:[item.ref_msg.message_item??item.ref_msg]}))
    }
    if(raw.appmsg||raw.content)texts.push(forwardedText(raw.appmsg??raw.content))
    const context={prepared:true,text:texts.join('\n\n')||row.text,assets,hasMedia,preparedAt:Date.now()}
    this.store.setInputContext(row.id,context)
    return context
  }
}
