import { createHash,randomBytes,scryptSync,timingSafeEqual } from 'node:crypto'
import { directSource } from './memory.mjs'

const hash=s=>createHash('sha256').update(s).digest('hex')
export function cents(value){
  const s=String(value).trim().replace(/^[¥￥]/,'')
  if(!/^\d{1,10}(\.\d{1,2})?$/.test(s))throw Error('金额须为最多两位小数的正数')
  const [a,b='']=s.split('.'),n=Number(a)*100+Number(b.padEnd(2,'0'))
  if(!Number.isSafeInteger(n)||n<=0||n>100000000000)throw Error('金额超出范围')
  return n
}
function date(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw Error('日期须为有效 YYYY-MM-DD');return s}
function text(s,max=500){if(typeof s!=='string'||s.length>max)throw Error('文字字段无效');return s.trim()}
export const LEDGER_CATEGORIES={expense:['购物','餐饮','学费','网站维护','订阅','交通','居住','医疗','娱乐','其他支出','待确认'],income:['网站收入','生活费','工资','奖助学金','其他收入','待确认'],refund:['购物','餐饮','学费','网站维护','订阅','交通','居住','医疗','娱乐','其他支出','待确认'],transfer:['账户划转']}
export class Ledger{
  constructor(store){this.store=store;this.db=store.db;this.db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_entries(id INTEGER PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,day TEXT NOT NULL,kind TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),category TEXT NOT NULL,counterparty TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',account TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '',external_id TEXT,source TEXT NOT NULL,voided INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_day ON ledger_entries(day,id);
    CREATE TABLE IF NOT EXISTS ledger_changes(id INTEGER PRIMARY KEY,entry_id INTEGER NOT NULL,before_json TEXT,after_json TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_imports(id INTEGER PRIMARY KEY,digest TEXT NOT NULL UNIQUE,label TEXT NOT NULL,report TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_labels(entry_id INTEGER PRIMARY KEY,confidence REAL NOT NULL,reason TEXT NOT NULL,refund_of INTEGER,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_sessions(hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
  `)}
  insert(input,sourceKey,source){
    const day=date(input.day),kind=input.kind,amount=cents(input.amount)
    if(!['income','expense','refund','transfer'].includes(kind))throw Error('收支类型无效')
    const values={day,kind,amount_cents:amount,category:text(input.category??'未分类',60)||'未分类',counterparty:text(input.counterparty??'',200),description:text(input.description??'',2000),account:text(input.account??'',200),status:text(input.status??'',100),external_id:input.externalId?text(input.externalId,200):null}
    const previous=this.db.prepare('SELECT * FROM ledger_entries WHERE source_key=?').get(sourceKey)
    if(previous){if(['day','kind','amount_cents'].some(k=>previous[k]!==values[k]))throw Error('同一来源的日期或金额有冲突，请按编号更正');return {id:previous.id,duplicate:true}}
    const now=Date.now(),id=Number(this.db.prepare('INSERT INTO ledger_entries(source_key,day,kind,amount_cents,category,counterparty,description,account,status,external_id,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(sourceKey,day,kind,amount,values.category,values.counterparty,values.description,values.account,values.status,values.external_id,JSON.stringify(source),now,now).lastInsertRowid)
    this.db.prepare('INSERT INTO ledger_changes(entry_id,after_json,reason,created_at) VALUES(?,?,?,?)').run(id,JSON.stringify(values),'新增',now)
    return {id,duplicate:false}
  }
  record(input){
    const src=directSource(this.store,input.sourceId),quote=text(input.quote,4000)
    if(!src||!quote||!src.direct_text.includes(quote))throw Error('记账需要绑定用户直接原文证据，不能使用转发或猜测')
    const amount=cents(input.amount),numbers=quote.match(/\d+(?:\.\d{1,2})?/g)??[]
    if(!numbers.some(n=>{try{return cents(n)===amount}catch{return false}}))throw Error('金额与原文不符')
    return this.store.transaction(()=>this.insert(input,'wechat:'+src.id+':'+hash(quote+':'+input.kind),{kind:'wechat',id:src.id,quote}))
  }
  amend({id,revision,patch,reason}){
    if(!Number.isSafeInteger(id)||!Number.isSafeInteger(revision)||!patch||typeof patch!=='object'||Array.isArray(patch)||!text(reason,500))throw Error('更正需要编号、版本和原因')
    const allowed=['day','kind','amount','category','counterparty','description','account','voided']
    if(Object.keys(patch).some(k=>!allowed.includes(k)))throw Error('更正字段无效')
    return this.store.transaction(()=>{
      const before=this.db.prepare('SELECT * FROM ledger_entries WHERE id=?').get(id)
      if(!before||before.revision!==revision)throw Error('账目已更新，请重新读取当前版本')
      const after={...before,...patch};if('amount' in patch)after.amount_cents=cents(patch.amount)
      date(after.day);if(!['income','expense','refund','transfer'].includes(after.kind))throw Error('类型无效')
      for(const k of ['category','counterparty','description','account'])after[k]=text(after[k],k==='description'?2000:200)
      if('voided' in patch&&typeof patch.voided!=='boolean')throw Error('作废状态无效')
      this.db.prepare('DELETE FROM ledger_labels WHERE entry_id=?').run(id)
      for(const dependent of this.db.prepare('SELECT e.* FROM ledger_entries e JOIN ledger_labels l ON l.entry_id=e.id WHERE l.refund_of=?').all(id)){
        this.db.prepare("UPDATE ledger_entries SET category='待确认',revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),dependent.id)
        this.db.prepare('DELETE FROM ledger_labels WHERE entry_id=?').run(dependent.id)
        this.db.prepare('INSERT INTO ledger_changes(entry_id,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?)').run(dependent.id,JSON.stringify(dependent),JSON.stringify({category:'待确认'}),'原支出更正，退款分类需重新核实',Date.now())
      }
      this.db.prepare('UPDATE ledger_entries SET day=?,kind=?,amount_cents=?,category=?,counterparty=?,description=?,account=?,voided=?,revision=revision+1,updated_at=? WHERE id=?').run(after.day,after.kind,after.amount_cents,after.category,after.counterparty,after.description,after.account,after.voided?1:0,Date.now(),id)
      this.db.prepare('INSERT INTO ledger_changes(entry_id,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?)').run(id,JSON.stringify(before),JSON.stringify(after),reason,Date.now())
      return {id,revision:revision+1}
    })
  }
  importBill({format='wechat-xlsx',digest,label,rows,control}){
    if(!['wechat-xlsx','alipay-csv'].includes(format))throw Error('账单格式无效')
    if(!/^[a-f0-9]{64}$/.test(digest)||!Array.isArray(rows)||rows.length>100000)throw Error('账单导入格式无效')
    const old=this.db.prepare('SELECT report FROM ledger_imports WHERE digest=?').get(digest);if(old)return {...JSON.parse(old.report),duplicateFile:true}
    const alipay=format==='alipay-csv',sourceKind=alipay?'alipay':'wechat-pay'
    return this.store.transaction(()=>{
      const sums={income:0,expense:0,transfer:0},counts={income:0,expense:0,transfer:0};let inserted=0
      const ids=new Set()
      for(const row of rows){
        if(!row.externalId||ids.has(row.externalId))throw Error('账单交易号缺失或重复');ids.add(row.externalId)
        const rawKind=row.kind==='refund'?'income':row.kind
        if(!(rawKind in sums))throw Error('账单方向无效')
        sums[rawKind]+=cents(row.amount);counts[rawKind]++
        if(!this.insert(row,sourceKind+':'+row.externalId,{kind:sourceKind,digest,label,row:row.row}).duplicate)inserted++
      }
      if(alipay){
        const skipped=control?.skipped,total=control?.total
        if(!Number.isSafeInteger(total)||total!==rows.length+(skipped?.count??0))throw Error('支付宝明细行数与账单页头不一致，已回滚')
        if(!Array.isArray(skipped?.rows)||skipped.rows.length!==skipped.count)throw Error('支付宝未入账明细缺失，已回滚')
        if(skipped.rows.reduce((n,row)=>n+cents(row.amount),0)!==skipped.cents)throw Error('支付宝未入账金额核对失败，已回滚')
        if(Object.keys(sums).some(k=>sums[k]!==control?.settled?.[k]?.cents||counts[k]!==control?.settled?.[k]?.count))throw Error('支付宝明细汇总与解析结果不一致，已回滚')
      }else if(!control||Object.keys(sums).some(k=>sums[k]!==control[k]?.cents||counts[k]!==control[k]?.count))throw Error('明细与微信账单原始汇总不一致，已回滚')
      const report={format,inserted,duplicates:rows.length-inserted,rows:rows.length,sourceTotals:sums,sourceCounts:counts}
      if(alipay)Object.assign(report,{skipped:control.skipped.count,footer:control.footer,note:'支付宝页头统计含交易关闭与等待收发货，且官方注明明细累加可能与页头不一致；仅入账交易成功/退款成功，金额以逐笔明细为准'})
      this.db.prepare('INSERT INTO ledger_imports(digest,label,report,created_at) VALUES(?,?,?,?)').run(digest,text(label,300),JSON.stringify(report),Date.now())
      return report
    })
  }
  summary(month){
    if(month!==undefined&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('月份无效')
    const rows=this.db.prepare("SELECT substr(day,1,7) month,kind,sum(amount_cents) cents,count(*) count FROM ledger_entries WHERE voided=0 AND (? IS NULL OR substr(day,1,7)=?) GROUP BY month,kind ORDER BY month").all(month??null,month??null)
    const months={};for(const r of rows){months[r.month]??={month:r.month,income:0,expense:0,refund:0,transfer:0,count:0};months[r.month][r.kind]=r.cents;months[r.month].count+=r.count}
    return Object.values(months).map(r=>({...r,netExpense:r.expense-r.refund,balance:r.income+r.refund-r.expense}))
  }
  list({month,after=0,limit=50,pending=false}={}){
    this.summary(month)
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('分页无效')
    const anchor=after?this.db.prepare('SELECT day,id FROM ledger_entries WHERE id=?').get(after):null
    if(after&&!anchor)throw Error('分页游标不存在')
    const rows=this.db.prepare("SELECT e.*,l.confidence,l.reason classification_reason,l.refund_of FROM ledger_entries e LEFT JOIN ledger_labels l ON l.entry_id=e.id WHERE (?=0 OR (e.voided=0 AND e.kind<>'transfer' AND e.category IN ('未分类','待确认','退款'))) AND (? IS NULL OR day<? OR (day=? AND id<?)) AND (? IS NULL OR substr(day,1,7)=?) ORDER BY day DESC,id DESC LIMIT ?").all(pending?1:0,anchor?.day??null,anchor?.day??null,anchor?.day??null,after,month??null,month??null,limit)
    return {entries:rows.map(r=>({...r,source:JSON.parse(r.source)})),nextAfter:rows.at(-1)?.id??after}
  }
  classify({items}){
    if(!Array.isArray(items)||!items.length||items.length>100)throw Error('每批分类须为1至100条')
    return this.store.transaction(()=>{
      const seen=new Set(),results=[]
      for(const item of items){
        if(!Number.isSafeInteger(item.id)||seen.has(item.id)||!Number.isSafeInteger(item.revision))throw Error('分类编号或版本无效');seen.add(item.id)
        const before=this.db.prepare('SELECT * FROM ledger_entries WHERE id=? AND voided=0').get(item.id)
        if(!before||before.revision!==item.revision)throw Error('账目已更新，请重新读取当前版本')
        const reason=text(item.reason,500),confidence=item.confidence
        if(!reason||typeof confidence!=='number'||!Number.isFinite(confidence)||confidence<0||confidence>1)throw Error('账目 #'+item.id+' 的置信度或依据无效')
        if(!LEDGER_CATEGORIES[before.kind].includes(item.category))throw Error('账目 #'+item.id+' 类型为 '+before.kind+'，允许类别：'+LEDGER_CATEGORIES[before.kind].join('、'))
        if(before.kind==='expense'&&item.category!==before.category&&this.db.prepare('SELECT 1 FROM ledger_labels WHERE refund_of=?').get(item.id))throw Error('先将关联退款改为待确认，再修改原支出类别')
        if(confidence<0.8&&item.category!=='待确认')throw Error('低置信度账目须标待确认')
        let refundOf=null
        if(item.refundOf!==undefined&&item.refundOf!==null){
          const original=this.db.prepare("SELECT * FROM ledger_entries WHERE id=? AND kind='expense' AND voided=0").get(item.refundOf)
          if(before.kind!=='refund'||!original||original.day>before.day||original.category!==item.category||item.category==='待确认')throw Error('退款关联的原支出或类别无效')
          const refunded=this.db.prepare("SELECT coalesce(sum(e.amount_cents),0) n FROM ledger_labels l JOIN ledger_entries e ON e.id=l.entry_id WHERE l.refund_of=? AND e.voided=0 AND e.kind='refund' AND e.id<>?").get(item.refundOf,item.id).n
          if(refunded+before.amount_cents>original.amount_cents)throw Error('关联退款超过原支出')
          refundOf=original.id
        }
        if(before.kind==='refund'&&item.category!=='待确认'&&refundOf===null)throw Error('退款分类须关联已核实的原支出，否则标待确认')
        this.db.prepare('UPDATE ledger_entries SET category=?,revision=revision+1,updated_at=? WHERE id=?').run(item.category,Date.now(),item.id)
        this.db.prepare('INSERT INTO ledger_labels VALUES(?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET confidence=excluded.confidence,reason=excluded.reason,refund_of=excluded.refund_of,updated_at=excluded.updated_at').run(item.id,confidence,reason,refundOf,Date.now())
        this.db.prepare('INSERT INTO ledger_changes(entry_id,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?)').run(item.id,JSON.stringify(before),JSON.stringify({category:item.category,confidence,refundOf}),'Agent分类：'+reason,Date.now())
        results.push({id:item.id,revision:item.revision+1,category:item.category})
      }
      return {updated:results.length,entries:results,pending:this.pending()}
    })
  }
  pending(){return this.db.prepare("SELECT count(*) n FROM ledger_entries WHERE voided=0 AND kind<>'transfer' AND category IN ('未分类','待确认','退款')").get().n}
  categories(month){
    this.summary(month)
    const rows=this.db.prepare("SELECT substr(day,1,7) month,CASE WHEN kind='refund' THEN 'expense' ELSE kind END kind,category,sum(CASE WHEN kind='refund' THEN -amount_cents ELSE amount_cents END) cents FROM ledger_entries WHERE voided=0 AND kind<>'transfer' AND (? IS NULL OR substr(day,1,7)=?) GROUP BY month,CASE WHEN kind='refund' THEN 'expense' ELSE kind END,category ORDER BY month,kind,category").all(month??null,month??null)
    const grouped=new Map();for(const r of rows){const category=LEDGER_CATEGORIES[r.kind].includes(r.category)?r.category:'待确认',key=r.month+':'+r.kind+':'+category;if(grouped.has(key))grouped.get(key).cents+=r.cents;else grouped.set(key,{...r,category})}return [...grouped.values()]
  }
  publicSummary(){
    if(!this.store.get('ledger_public_enabled',false))return {published:false,months:[]}
    const months=this.summary().slice(-6)
    return {published:true,currency:'CNY',unit:'cents',precision:'exact',categories:this.categories().filter(r=>months.some(m=>m.month===r.month)),months:months.map(r=>({month:r.month,income:r.income,expense:r.netExpense,balance:r.balance}))}
  }
  setPassword(password){
    if(typeof password!=='string'||password.length<12||password.length>200)throw Error('登录密码须为12至200字符')
    const salt=randomBytes(16).toString('hex');this.store.set('ledger_password',{salt,hash:scryptSync(password,salt,32).toString('hex')});this.db.prepare('DELETE FROM ledger_sessions').run()
  }
  login(password){
    const saved=this.store.get('ledger_password'),candidate=typeof password==='string'&&password.length<=200?password:''
    const computed=scryptSync(candidate,saved?.salt??'not-configured',32),expected=Buffer.from(saved?.hash??'0'.repeat(64),'hex')
    if(!saved||!timingSafeEqual(computed,expected))return null
    this.db.prepare('DELETE FROM ledger_sessions WHERE expires_at<=?').run(Date.now())
    const token=randomBytes(32).toString('hex');this.db.prepare('INSERT INTO ledger_sessions VALUES(?,?)').run(hash(token),Date.now()+7*86400000);return token
  }
  authenticated(token){return typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&!!this.db.prepare('SELECT 1 FROM ledger_sessions WHERE hash=? AND expires_at>?').get(hash(token),Date.now())}
  logout(token){if(typeof token==='string')this.db.prepare('DELETE FROM ledger_sessions WHERE hash=?').run(hash(token))}
}
