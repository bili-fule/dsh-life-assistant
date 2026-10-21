const $=s=>document.querySelector(s)
let token=sessionStorage.getItem('life-token')||new URLSearchParams(location.hash.slice(1)).get('token')||''
if(location.hash)history.replaceState(null,'',location.pathname)
let state,qrObjectURL,tab='tasks',loading=false
const labels={open:'待办',confirm:'待确认',waiting:'等别人',done:'已完成',cancelled:'已取消',pending:'待处理',processing:'处理中',failed:'需要重试',sent:'已送达',superseded:'已作废',sending:'发送中'}
const format=ms=>ms?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ms):'未定时间'
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n}
function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;setTimeout(()=>$('#toast').hidden=true,4500)}
async function api(path,data){const r=await fetch(path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});if(r.status===401){sessionStorage.removeItem('life-token');$('#login').hidden=false;$('#app').hidden=true;throw Error('请重新输入管理密钥')}if(!r.ok){const j=await r.json();throw Error(j.error||'操作未完成')}return r.headers.get('content-type')?.includes('json')?r.json():r}
async function action(path,data,msg){try{await api(path,data);if(msg)toast(msg);await refresh()}catch(e){toast(e.message)}}
function button(text,fn,cls='secondary'){const b=el('button',text,cls);b.onclick=async()=>{b.disabled=true;try{await fn()}catch(e){toast(e.message)}finally{b.disabled=false}};return b}
function empty(parent,text){parent.replaceChildren(el('div',text,'empty'))}
function renderTasks(){const all=state.tasks,shown=all.filter(t=>$('#show-done').checked||!['done','cancelled'].includes(t.status));for(const [key,id]of[['open','open-count'],['confirm','confirm-count'],['waiting','waiting-count'],['done','done-count']])$('#'+id).textContent=all.filter(t=>t.status===key).length;const root=$('#task-list');root.replaceChildren();if(!shown.length)return empty(root,'暂时没有挂心的事。发一条消息，交给助理整理。');for(const t of shown){const n=el('article',null,'card task'),body=el('div',null,'task-body'),heading=el('h3',`#${t.id} ${t.title}`),meta=el('div');meta.append(el('span',labels[t.status],'tag '+t.status),el('span',t.due_at?'截止 '+format(t.due_at):'未设截止时间','meta'));body.append(heading,meta,el('p',t.reason));const details=el('details');details.append(el('summary','查看原文依据'),el('blockquote',t.evidence));body.append(details);const buttons=el('div',null,'buttons');if(t.status==='confirm')buttons.append(button('确认要办',()=>action('/api/task',{id:t.id,status:'open'})));if(!['done','cancelled'].includes(t.status)){buttons.append(button('完成',()=>action('/api/task',{id:t.id,status:'done'},'这件事已经落下了。')));buttons.append(button('稍后提醒',()=>action('/api/task',{id:t.id,remindAt:new Date(Date.now()+30*60000).toISOString()},'30 分钟后提醒；免打扰期间会顺延。')));buttons.append(button('取消',()=>action('/api/task',{id:t.id,status:'cancelled'}),'danger'))}n.append(body,buttons);root.append(n)}}
function renderInbox(){const root=$('#inbox-list');root.replaceChildren();if(!state.inbox.length)return empty(root,'这里会保留你的消息原文和每次分析。');for(const row of state.inbox){const n=el('article',null,'card');n.append(el('div',`原文 #${row.id} · ${format(row.received_at)} · ${labels[row.state]||row.state}${row.batch_id?' · 合并批次 #'+row.batch_id:''}`,'meta'),el('p',row.text,'text-block'));if(row.readable_text){const d=el('details');d.append(el('summary','查看文件和图片提取的正文'),el('pre',row.readable_text));n.append(d)}for(const a of row.assets||[]){n.append(button('下载 '+a.name,()=>downloadFile(a.path,a.name)))}if(row.result){const d=el('details'),r=JSON.parse(row.result);d.append(el('summary','查看判断记录'),el('pre',JSON.stringify(r,null,2)));n.append(d)}if(row.error)n.append(el('p','分析未完成：'+row.error));if(row.state==='failed')n.append(button('重新分析',()=>action('/api/retry',{id:row.id},'已放回处理队列')));root.append(n)}}
function renderCommunication(){const root=$('#communication-list');root.replaceChildren();for(const i of state.communication||[]){const card=el('details');const status={explicit:'你明确说过',supported:'多次观察，原因仍待验证',hypothesis:'待验证假设'};card.append(el('summary',i.pattern+' · '+status[i.status]),el('p','场景：'+i.context),el('p',(i.rationaleStatus==='self_report'?'你说明的原因：':'可能的原因：')+i.rationale),el('p','回应方式：'+i.guidance),el('p','依据：'+i.sources.map(s=>'#'+s.inbox_id+'「'+s.quote+'」').join('、')),button('移除这个判断',()=>action('/api/forget-insight',{id:i.id},'已移除这条表达分析'),'danger'));root.append(card)}}
function renderMemory(){renderCommunication();if(document.activeElement!==$('#persona'))$('#persona').value=state.persona;$('#style-learning').checked=state.styleLearning;const names={short:'简短',balanced:'适中',detailed:'详细',direct:'直接',warm:'温和',formal:'正式',bullets:'清单式',prose:'连贯段落'};const style=Object.values(state.learnedStyle).map(v=>names[v]||v);$('#style-info').textContent=style.length?'已观察到：'+style.join('、'):'还在熟悉你的表达，暂未形成稳定偏好。';const root=$('#memory-list');root.replaceChildren();if(!state.memories.length)empty(root,'还在了解你。有依据的长期信息会主动整理到这里，也可随时要求记住或忘记。');else for(const m of state.memories){const n=el('div',null,'card row');const layers={profile:'身份与偏好',projects:'长期项目',relations:'关系',episodes:'经历',procedures:'处理规则'};n.append(el('span',`#${m.id} · ${layers[m.layer]||'长期记忆'}${m.topic?' · '+m.topic:''}\n${m.body}`),button('忘记',()=>action('/api/forget',{id:m.id},'已移除这条长期记忆'),'danger'));root.append(n)}$('#checkpoint').textContent=state.engine==='DSH native Agent'?'263K Token 触发 DSH 原生压缩，当前模型声明容量仍为 100 万。记忆按身份偏好、项目、关系、经历和处理规则分层，按需检索；聊天空闲和夜间会继续整理。'+(state.checkpoint?'\n\n迁移前摘要：\n'+state.checkpoint.summary:''):state.checkpoint?`${format(state.checkpoint.created_at)} · 已整理至原文 #${state.checkpoint.through_id}\n\n${state.checkpoint.summary}`:'还没有需要压缩的历史。'}
function renderConnection(){const l=state.login;$('#wechat-status').textContent=state.bound?'微信已绑定，等待你的事务消息。':l?.message||'尚未绑定微信。';$('#bind').disabled=state.bound;$('#unbind').disabled=!state.bound;$('#verify-form').hidden=l?.status!=='need_verifycode';if(!state.bound&&l&&['wait','scaned','need_verifycode','scaned_but_redirect'].includes(l.status))loadQR();else $('#qr').hidden=true;if(document.activeElement!==$('#quiet-start'))$('#quiet-start').value=state.quiet.start;if(document.activeElement!==$('#quiet-end'))$('#quiet-end').value=state.quiet.end;if(document.activeElement!==$('#digest'))$('#digest').value=state.digestHour===null?'off':state.digestHour;$('#runtime-info').textContent=`模型：${state.provider} / ${state.model}\n分析状态：${state.modelHealth?state.modelHealth.ok?'最近一次正常':'最近分析未完成':'尚未分析消息'}\n消息合并：首条起 ${state.batching?.quietSeconds??5} 秒；AI 可按需再等
记忆整理：空闲 ${state.maintenance?.idleSeconds??300} 秒，夜间 ${state.maintenance?.nightHour??3}:00 整理并压缩\n最近互动：${format(state.lastInbound)}\n每日自动备份，保留最近 7 份。`;$('#runtime-info').style.whiteSpace='pre-line';const root=$('#outbox-list');root.replaceChildren();if(!state.outbox.length)empty(root,'还没有发送记录。');else for(const r of state.outbox){const n=el('div',null,'card row');n.append(el('span',`${r.kind==='reply'?'消息回复':r.kind==='file'?'文件回传':r.kind==='digest'?'每日清单':'事务提醒'} · ${labels[r.state]||r.state}${r.attempts?' · 已尝试 '+r.attempts+' 次':''}`),el('span',format(r.sent_at||r.created_at),'meta'));if(r.error)n.append(el('span','暂未送达','danger'));root.append(n)}}
let qrLoaded=false
async function loadQR(){if(qrLoaded)return;qrLoaded=true;try{const r=await api('/api/qr.svg');if(qrObjectURL)URL.revokeObjectURL(qrObjectURL);qrObjectURL=URL.createObjectURL(await r.blob());$('#qr').src=qrObjectURL;$('#qr').hidden=false}catch{qrLoaded=false}}
async function refresh(){if(loading||!token)return;loading=true;try{state=await api('/api/state');sessionStorage.setItem('life-token',token);$('#login').hidden=true;$('#app').hidden=false;$('#connected').textContent=state.bound?'微信已连接':'尚未连接微信';const warning=state.deliveryError?.message||state.pollError?.message;$('#notice').hidden=!warning;$('#notice').textContent=warning||'';renderTasks();renderInbox();renderMemory();renderConnection();renderTools();renderYoyo()}catch(e){if(!state)toast(e.message)}finally{loading=false}}
for(const b of document.querySelectorAll('nav button'))b.onclick=()=>{tab=b.dataset.tab;for(const n of document.querySelectorAll('.tab'))n.hidden=n.id!==tab;for(const n of document.querySelectorAll('nav button'))n.classList.toggle('active',n===b);$('#page-title').textContent=b.textContent}
$('#auth-form').onsubmit=e=>{e.preventDefault();token=$('#token').value.trim();refresh()}
$('#capture-form').onsubmit=async e=>{e.preventDefault();const value=$('#capture').value;try{await api('/api/inbox',{text:value});$('#capture').value='';toast('原文已保存，正在整理。');refresh()}catch(e){toast(e.message)}}
$('#persona-form').onsubmit=e=>{e.preventDefault();action('/api/settings',{persona:$('#persona').value},'人设已保存。')}
$('#style-learning').onchange=()=>action('/api/settings',{styleLearning:$('#style-learning').checked},'语言学习设置已保存。')
$('#reset-style').onclick=()=>{if(confirm('清空学到的语言偏好？你设置的人设会保留。'))action('/api/settings',{resetStyle:true},'已清空所学偏好。')}
$('#bind').onclick=async()=>{qrLoaded=false;action('/api/login',{},'二维码已生成，请用微信扫描。')}
$('#unbind').onclick=()=>{if(confirm('解绑微信？待办和记忆会保留。'))action('/api/unbind',{},'微信已解绑。')}
$('#verify-form').onsubmit=e=>{e.preventDefault();action('/api/verify',{code:$('#verify').value.trim()},'正在验证配对码。')}
for(let h=0;h<24;h++){const option=el('option',String(h).padStart(2,'0')+':00');option.value=h;$('#digest').append(option)}
$('#reminder-form').onsubmit=e=>{e.preventDefault();action('/api/settings',{quiet:{start:Number($('#quiet-start').value),end:Number($('#quiet-end').value)},digestHour:$('#digest').value==='off'?null:Number($('#digest').value)},'提醒偏好已保存。')}
$('#compact').onclick=()=>action('/api/compact',{},'上下文整理已完成。')
$('#backup').onclick=()=>action('/api/backup',{},'已在服务器创建备份。')
$('#export').onclick=async()=>{try{const data=await api('/api/export'),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='life-assistant-export.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){toast(e.message)}}
$('#show-done').onchange=()=>state&&renderTasks()
refresh();setInterval(refresh,5000)

async function downloadFile(path,name){const response=await api('/api/asset?path='+encodeURIComponent(path)),url=URL.createObjectURL(await response.blob()),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function renderTools(){const files=$('#workspace-files'),runs=$('#tool-list');files.replaceChildren();runs.replaceChildren();for(const f of (state.workspaceFiles||[]).slice(0,40)){const row=el('div',null,'row');row.append(el('span',f.name+' · '+Math.ceil(f.bytes/1024)+' KB'),button('下载',()=>downloadFile(f.path,f.name)));files.append(row)}if(!files.children.length)empty(files,'工作目录还没有文件。');for(const r of state.toolRuns||[]){const d=el('details');d.append(el('summary',r.name+' · '+(r.state==='done'?'已结束':'执行中/结果待核对')+' · '+format(r.created_at)),el('pre','参数：'+r.args+'\n结果：'+(r.result||'尚无结果')));runs.append(d)}if(!runs.children.length)empty(runs,'还没有需要调用工具的任务。')}
$('#uploads').onchange=async()=>{const files=[...$('#uploads').files];if(files.length>8){toast('一次最多上传 8 个文件');return}for(const f of files){if(f.size>32*1024*1024){toast(f.name+' 超过 32MiB，未上传');continue}try{toast('正在上传 '+f.name);const data=await new Promise((yes,no)=>{const reader=new FileReader();reader.onload=()=>yes(String(reader.result).split(',')[1]);reader.onerror=no;reader.readAsDataURL(f)});await api('/api/upload',{name:f.name,data});toast(f.name+' 已保存，正在读取。')}catch(e){toast(e.message)}}$('#uploads').value='';refresh()}

const teamLabels={ready:'等待调度',running:'执行中',waiting:'等待对方回复',blocked:'已阻塞',completed:'已完成',cancelled:'已取消',failed:'失败'}
// The operations panel only shows what the host already exposes outside any
// scope: who is running, why it waits, and what it spent. Task goals and report
// text stay inside that task's own material scope, never on this page.
function renderTeam(team){
 const root=$('#yoyo-team');root.replaceChildren()
 if(!team)return empty(root,'团队编排未启用；启用后这里只显示执行者、发言租约、等待原因与用量。')
 root.append(el('div','在跑 '+team.concurrency.running+' / '+team.concurrency.max+' 个执行者 · 任务目的与报告正文不在本页展示，需要时回到该任务的资料范围查看','card text-block'))
 if(!team.tasks.length)return empty(root,'还没有分派过任务。')
 for(const t of team.tasks){
  const state=teamLabels[t.state]||t.state
  const facts=['#'+String(t.id).slice(0,8)+' · '+t.role+' · '+state+(t.waitReason&&t.waitReason!==state?' · '+t.waitReason:''),
   '尝试 '+(t.attempt??0)+' 次 · 失败 '+(t.failures??0)+' 次'+(t.retry_at?' · 计划重试 '+format(t.retry_at):''),
   (t.steps??0)+' 步 · '+(t.tokensReported?(t.tokens??0)+' Token':'Token 未上报（0 表示未测量，不代表没有消耗）')+' · 报告 '+(t.reports??0)+' 条 · 证据 '+(t.evidence??0)+' 条',
   t.leaseExpires?'发言租约到 '+format(t.leaseExpires):'当前没有发言租约',
   t.dependsOn?'依赖 '+t.dependsOn+' 个任务':'无依赖']
  root.append(el('div',facts.join('\n'),'card text-block'))
 }
}
function renderYoyo(){
 const y=state.autonomy;if(!y)return
 if(document.activeElement!==$('#yoyo-persona'))$('#yoyo-persona').value=y.persona||''
 const plans=$('#yoyo-plans');plans.replaceChildren();for(const p of y.plans??[])plans.append(el('div','#'+p.id+' · '+p.title+' · '+({open:'进行中',waiting:'等待',done:'完成',cancelled:'已取消'}[p.state]||p.state)+(p.progress?'\n'+p.progress:''),'card text-block'));if(!plans.children.length)empty(plans,'还没有保存自己的打算。')
 $('#yoyo-status').textContent=!y.enabled?'自主模式尚未启用，微信事务仍正常工作。':!y.nativeReady?'原生资料视图尚未就绪，自主活动不会运行。':y.settings.paused?'yoyo 已暂停。':y.settings.observeOnly?'正在观察，会记录打算但不发送消息。':'自主活动已开启，今日已用 '+(y.usage?.steps??0)+' / '+y.settings.dailySteps+' 个模型步骤。'
 $('#yoyo-activity').textContent=[y.activity?.body?.description,y.activity?.body?.next?'下一步：'+y.activity.body.next:'',y.activity?.wake_at?'下次关注：'+format(y.activity.wake_at):''].filter(Boolean).join('\n')||'暂时没有正在进行的打算。'
 if(document.activeElement!==$('#yoyo-budget'))$('#yoyo-budget').value=y.settings.dailySteps??0
 $('#yoyo-observe').checked=y.settings.observeOnly!==false
 $('#yoyo-pause').textContent=y.settings.paused?'继续活动':'暂停活动'
 const memoryJobs=$('#yoyo-memory-jobs');memoryJobs.replaceChildren();for(const r of y.memoryMaintenance?.jobs??[]){const card=el('div','#'+r.id+' · '+({idle:'空闲整理',night:'夜间整理'}[r.kind]||r.kind)+' · 原文至 #'+r.through_id+' · '+({running:'整理中',done:'已完成',failed:'未完成',interrupted:'已中断'}[r.state]||r.state)+(r.error?' · '+r.error:''),'card');if(['failed','interrupted'].includes(r.state))card.append(button('重试本次整理',()=>action('/api/yoyo/memory-retry',{id:r.id},'已安排重试'),'secondary'));memoryJobs.append(card)}if(!memoryJobs.children.length)empty(memoryJobs,'没有待展示的后台整理。')
 renderTeam(y.team)
 const activityLog=$('#yoyo-activity-log');activityLog.replaceChildren();for(const r of y.recentActivity??[])activityLog.append(el('div',format(r.created_at)+' · '+(r.body.description||r.state)+(r.body.next?'\n下一步：'+r.body.next:''),'card text-block'));if(!activityLog.children.length)empty(activityLog,'尚无活动记录。')
 $('#yoyo-qq').textContent=y.qqConfigured?'已配置 QQ 接入，可检查登录账号。':'尚未配置 QQ 接入。'
 const targets=$('#yoyo-targets');targets.replaceChildren()
 for(const t of y.targets){const row=el('div',null,'card row');row.append(el('span',(t.label||'未命名窗口')+' · '+t.platform+' / '+t.kind+' · '+t.peer),button(t.approved?'撤销授权':'允许浏览和聊天',()=>action('/api/yoyo/approve',{target:t.handle,approved:!t.approved},'授权已更新'),t.approved?'danger':'secondary'));targets.append(row)}
 if(!targets.children.length)empty(targets,'收到 QQ 消息或绑定微信后，窗口会出现在这里。')
 const inbox=$('#yoyo-inbox');inbox.replaceChildren();for(const r of y.inbox.filter(r=>r.unread)){inbox.append(el('div',(r.label||r.handle)+' · '+r.unread+' 条未读'+(r.mentioned?' · 有人 @ 了我':''),'card'))}if(!inbox.children.length)empty(inbox,'暂时没有积累的新消息。')
 const out=$('#yoyo-outbox');out.replaceChildren();for(const r of y.outbox)out.append(el('div','#'+r.id+' · '+({queued:'已入队',sending:'发送中',sent:'已确认发送',uncertain:'结果不确定，待核对',retry_wait:'等待重试',cancelled:'已取消'}[r.state]||r.state)+(r.error?' · '+r.error:''),'card'));if(!out.children.length)empty(out,'还没有自主发信记录。')
}
$('#yoyo-settings').onsubmit=e=>{e.preventDefault();action('/api/yoyo/settings',{observeOnly:$('#yoyo-observe').checked,dailySteps:Number($('#yoyo-budget').value)},'活动设置已保存。')}
$('#yoyo-persona-form').onsubmit=e=>{e.preventDefault();action('/api/yoyo/settings',{persona:$('#yoyo-persona').value},'公开人设已保存。')}
$('#yoyo-wake').onclick=()=>action('/api/yoyo/wake',{},'已安排一次关注机会。')
$('#yoyo-pause').onclick=()=>action('/api/yoyo/settings',{paused:!state.autonomy.settings.paused},'活动状态已更新。')
$('#yoyo-qq-check').onclick=async()=>{try{const r=await api('/api/yoyo/qq-check',{});toast('QQ 已连接：'+r.account)}catch(e){toast(e.message)}}

$('#yoyo-qq-discover').onclick=async()=>{try{const r=await api('/api/yoyo/qq-discover',{});toast('已同步 '+r.groups+' 个群、'+r.friends+' 个好友；请逐个选择授权。');await refresh()}catch(e){toast(e.message)}}
