import { boundedText } from './scope.mjs'

// Deliberation belongs to the native Agent. This host ledger records its
// reasons and observed task state; it never manufactures needs or a new loop.
export class TeamMotivation {
  constructor(tasks,motivation=null) {
    this.tasks=tasks;this.social=tasks.social;this.db=tasks.db;this.motivation=motivation
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_team_intents(
        task_id TEXT PRIMARY KEY REFERENCES yoyo_team_tasks(id),
        concern_id INTEGER NOT NULL REFERENCES yoyo_concerns(id),
        rationale TEXT NOT NULL, done_when TEXT NOT NULL, stop_when TEXT NOT NULL,
        concern_revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_team_reviews(
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES yoyo_team_tasks(id),
        decision TEXT NOT NULL, reason TEXT NOT NULL, report_id INTEGER,
        task_state TEXT NOT NULL, created_at INTEGER NOT NULL);
    `)
    // A delegation can belong to one of the subject's own open choices. The
    // link never grants extra satisfaction: experiences are still deduplicated
    // by the real event, not by the number of executors.
    if(!this.db.prepare('PRAGMA table_info(yoyo_team_intents)').all().some(c=>c.name==='choice_id'))
      this.db.exec('ALTER TABLE yoyo_team_intents ADD COLUMN choice_id INTEGER')
  }
  delegate({concernId,choiceId,rationale,...args}) {
    rationale=boundedText(rationale,2000,'分工理由')
    const concern=this.social.concerns(args.viewId).find(c=>c.id===concernId)
    if(!concern||concern.state!=='active')throw Error('必须选择当前范围内的活跃关切')
    let choice=null
    if(choiceId!==undefined&&choiceId!==null){
      if(!this.motivation)throw Error('动机层未启用，不能关联自己的选择')
      choice=this.motivation.openChoice(this.social.view(args.viewId),choiceId)
      if(!choice)throw Error('动机选择不存在、已结束或不在当前资料范围')
    }
    return this.tasks.transaction(()=>{
      const task=this.tasks.create(args)
      const existing=this.db.prepare('SELECT * FROM yoyo_team_intents WHERE task_id=?').get(task.id)
      if(existing){
        if(existing.concern_id!==concernId||existing.rationale!==rationale||(existing.choice_id??null)!==(choice?.id??null))throw Error('分工理由与原任务冲突')
        return task
      }
      this.db.prepare('INSERT INTO yoyo_team_intents(task_id,concern_id,rationale,done_when,stop_when,concern_revision,created_at,choice_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(task.id,concernId,rationale,concern.doneWhen,concern.stopWhen,concern.updatedAt,this.tasks.clock(),choice?.id??null)
      return task
    })
  }
  deliberate(viewId) {
    const view=this.social.view(viewId),concerns=this.social.concerns(viewId)
    const work=[]
    for(const row of this.db.prepare('SELECT t.id,i.concern_id,i.choice_id FROM yoyo_team_tasks t JOIN yoyo_team_intents i ON t.id=i.task_id ORDER BY t.created_at DESC LIMIT 100').all()){
      try{
        const task=this.tasks.inspect(row.id,viewId)
        const intent=this.db.prepare('SELECT * FROM yoyo_team_intents WHERE task_id=?').get(row.id)
        const review=this.db.prepare('SELECT decision,reason,report_id,task_state FROM yoyo_team_reviews WHERE task_id=? ORDER BY id DESC LIMIT 1').get(row.id)??null
        const choice=row.choice_id&&this.motivation?this.motivation.openChoice(view,row.choice_id):null
        work.push({taskId:task.id,role:task.role,goal:task.goal,state:task.state,concernId:intent.concern_id,rationale:intent.rationale,doneWhen:intent.done_when,stopWhen:intent.stop_when,reports:this.tasks.reports(task.id,viewId),evidence:this.tasks.board(viewId,{taskId:task.id,limit:5}),review,
          choice:choice?{id:choice.id,activity:choice.activity,chosen:choice.chosen}:row.choice_id?{id:row.choice_id,retired:true}:null})
      }catch{/* Revoked and out-of-scope work never enters deliberation. */}
    }
    return {concerns,work,guidance:'依据当前证据决定自己行动、分派、调整、等待或放弃。任务完成不等于关切已满足；执行者报告是自述。同一活动由多个执行者汇报不会重复计入满足，最后的体验仍要你自己对照期待记录。无值得处理的事项可以休息，不必制造任务。'}
  }
  review(viewId,{taskId,decision,reason,reportId}) {
    const task=this.tasks.inspect(taskId,viewId)
    if(!['continue','revise','wait','done','abandon'].includes(decision))throw Error('动机复查决定无效')
    reason=boundedText(reason,2000,'复查理由')
    if(reportId!==undefined&&!this.db.prepare('SELECT 1 FROM yoyo_team_reports WHERE id=? AND task_id=?').get(reportId,taskId))throw Error('报告不属于该任务')
    // A review records the main Agent's interpretation, not proof and not an
    // implicit restart. New work requires an explicit, bounded delegation.
    const result=this.db.prepare('INSERT INTO yoyo_team_reviews(task_id,decision,reason,report_id,task_state,created_at) VALUES(?,?,?,?,?,?)')
      .run(taskId,decision,reason,reportId??null,task.state,this.tasks.clock())
    return {id:Number(result.lastInsertRowid),decision,evidence:reportId===undefined?'self_report':'worker_report',automaticallyScheduled:false}
  }
}
