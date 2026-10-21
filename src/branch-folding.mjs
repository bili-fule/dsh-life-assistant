import { createHash } from 'node:crypto'

// Cold branches are folded, not deleted. A finished branch that no longer supports
// anything active becomes a short summary with references to its real records; the
// subject's attention shrinks while the originals stay readable. This is separate
// from DSH's own context compaction: that one shortens model context, this one
// narrows what the subject is asked to hold in mind.
export class BranchFolding {
  constructor(social, tasks, intents, clock = Date.now) {
    this.social = social;this.tasks = tasks;this.intents = intents;this.db = social.db;this.clock = clock
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_folded_branches(
        id TEXT PRIMARY KEY, activity_id TEXT, view_id TEXT NOT NULL, summary TEXT NOT NULL,
        refs TEXT NOT NULL, through INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `)
  }
  // The hot chain: unfinished work, why it exists, what it needs, what was just
  // produced, and every unresolved disagreement or unkept promise.
  hotChain(viewId, { now = this.clock(), factLimit = 8 } = {}) {
    const view = this.social.view(viewId)
    const activities = this.social.activities(viewId).filter(activity => !['done', 'abandoned'].includes(activity.state))
    const intents = this.intents.list({ limit: 50, now }).filter(intent => ['ready', 'claimed', 'running', 'waiting', 'blocked'].includes(intent.state))
    const hotActivityIds = new Set([...activities.map(activity => activity.activityId), ...intents.map(intent => intent.activity_id).filter(Boolean)])
    const promises = this.social.concerns(viewId).filter(concern => ['active', 'waiting'].includes(concern.state))
      .slice(0, 8).map(concern => ({ id: concern.id, title: concern.title, next: concern.next ?? '', reviewAt: concern.reviewAt ?? null }))
    const conflicts = this.db.prepare("SELECT source,decision,reason FROM yoyo_team_source_decisions WHERE view_id=? AND decision='unresolved' ORDER BY id DESC LIMIT 10").all(viewId)
    const facts = this.tasks.board(viewId, { limit: factLimit }).map(entry => ({ taskId: entry.task_id, kind: entry.kind, source: entry.source, at: entry.created_at }))
    return {
      view: { focus: view.focus }, activityIds: [...hotActivityIds],
      activities: activities.slice(0, 8).map(activity => ({ activityId: activity.activityId, goal: activity.goal, state: activity.state })),
      intents: intents.slice(0, 10).map(intent => ({ id: intent.id, goal: intent.goal, capabilities: intent.capabilities, state: intent.state, dependsOn: intent.dependsOn })),
      promises, conflicts, facts,
      note: '热链路：未完成意图、它们的起因、刚产生的事实、未解决的冲突与没兑现的承诺。已折叠的分支只留摘要与引用。',
    }
  }
  // Folding takes one whole finished stretch per activity: it never folds work that
  // is still referenced by an active intent, an open question or an unresolved
  // disagreement, so a live thread cannot lose its evidence.
  fold(viewId, { now = this.clock(), olderThanMs = 6 * 3600000 } = {}) {
    const folded = []
    const hot = this.hotChain(viewId, { now })
    const hotActivity = new Set(hot.activityIds)
    for (const activity of this.social.activities(viewId)) {
      if (hotActivity.has(activity.activityId)) continue
      const terminal = this.intents.list({ activityId: activity.activityId, limit: 50, now })
        .filter(intent => ['completed', 'abandoned'].includes(intent.state) && intent.updated_at < now - olderThanMs)
      if (!terminal.length) continue
      const refs = []
      let disputed = false
      for (const intent of terminal) {
        if (!intent.task_id) { refs.push({ intentId: intent.id, state: intent.state }); continue }
        let task = null
        try { task = this.tasks.inspect(intent.task_id, viewId) } catch { refs.push({ intentId: intent.id, state: intent.state, revoked: true }); continue }
        const reports = this.tasks.reports(task.id, viewId).map(report => report.id)
        const evidence = this.tasks.board(viewId, { taskId: task.id, limit: 50 })
        const events = this.tasks.activityEvents(viewId, { taskId: task.id, limit: 50 }).map(event => event.eventId)
        // A source that was read by this branch and never ruled on keeps the
        // stretch in the hot chain: folding it would hide a live disagreement.
        for (const entry of evidence) if (this.db.prepare("SELECT 1 FROM yoyo_team_source_decisions WHERE view_id=? AND decision='unresolved' AND source=?").get(viewId, String(entry.source))) disputed = true
        refs.push({ intentId: intent.id, taskId: task.id, state: intent.state, reports, evidence: evidence.length, events })
      }
      if (disputed) continue
      const through = Math.max(...terminal.map(intent => intent.updated_at))
      const summary = `已完成 ${terminal.length} 项工作：` + terminal.map(intent => intent.goal).join('；').slice(0, 600)
      const id = 'fold-' + createHash('sha256').update(JSON.stringify([viewId, activity.activityId, through])).digest('hex').slice(0, 24)
      const previous = this.db.prepare('SELECT id FROM yoyo_folded_branches WHERE id=?').get(id)
      if (previous) continue
      this.db.prepare('INSERT INTO yoyo_folded_branches(id,activity_id,view_id,summary,refs,through,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, activity.activityId, viewId, summary, JSON.stringify(refs), through, now)
      folded.push({ id, activityId: activity.activityId, summary, refs: refs.length })
    }
    return { folded }
  }
  list(viewId, { limit = 10 } = {}) {
    this.social.view(viewId)
    return this.db.prepare('SELECT id,activity_id,summary,refs,through,created_at FROM yoyo_folded_branches WHERE view_id=? ORDER BY created_at DESC LIMIT ?').all(viewId, Math.min(50, limit))
      .map(row => ({ id: row.id, activityId: row.activity_id, summary: row.summary, refs: JSON.parse(row.refs).length, through: row.through, at: row.created_at }))
  }
  // Expanding goes back to the real records. The summary itself is never allowed to
  // become a fact: it points at reports, evidence and events, and says so.
  expand(viewId, id) {
    this.social.view(viewId)
    const row = this.db.prepare('SELECT * FROM yoyo_folded_branches WHERE id=? AND view_id=?').get(String(id), viewId)
    if (!row) throw Error('折叠分支不存在或不在当前资料范围')
    const refs = JSON.parse(row.refs)
    const detail = []
    for (const ref of refs) {
      if (!ref.taskId) { detail.push(ref); continue }
      let task = null
      try { task = this.tasks.inspect(ref.taskId, viewId) } catch { detail.push({ ...ref, revoked: true }); continue }
      detail.push({ ...ref, role: task.role, state: task.state, reports: this.tasks.reports(task.id, viewId).slice(0, 3), evidence: this.tasks.board(viewId, { taskId: task.id, limit: 5 }) })
    }
    return { id: row.id, activityId: row.activity_id, summary: row.summary, branches: detail, note: '这是过去工作的摘要与引用，不是新事实；要作为依据请回到原始报告、证据与事件。' }
  }
}
