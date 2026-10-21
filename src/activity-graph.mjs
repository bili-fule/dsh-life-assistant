import { createHash } from 'node:crypto'

// The activity graph is derived, not a second authority: activities, intents,
// tasks, evidence, rulings and direction changes already exist, and this module
// only answers "why", "what changed direction", "who verified it", "what is still
// unknown" and "what does this conclusion rest on". Nothing is written back into
// those records, and no model reasoning is stored here.
export const NODE_KINDS = ['activity', 'intent', 'task', 'observation', 'decision', 'artifact']
export const EDGE_KINDS = ['derived_from', 'depends_on', 'produced', 'supports', 'contradicts', 'supersedes']

export class ActivityGraph {
  constructor(social, tasks, intents) {
    this.social = social;this.tasks = tasks;this.intents = intents;this.db = social.db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_graph_nodes(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, activity_id TEXT,
        label TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_graph_edges(
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY(from_id,to_id,kind));
    `)
  }
  nodeId(kind, ref) { return kind + ':' + createHash('sha256').update(String(ref)).digest('hex').slice(0, 16) }
  // Nodes are rebuilt from the live rows each time, so a retired branch or a
  // revoked window cannot linger in the graph as stale permission.
  sync(viewId, { now = Date.now() } = {}) {
    const view = this.social.view(viewId), scopes = JSON.stringify([...view.scopes].sort())
    const put = (id, kind, ref, activityId, label) => this.db.prepare(`INSERT INTO yoyo_graph_nodes(id,kind,ref,activity_id,label,scopes,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,scopes=excluded.scopes`).run(id, kind, String(ref), activityId ?? null, String(label ?? '').slice(0, 200), scopes, now)
    const edge = (from, to, kind, note = '') => this.db.prepare('INSERT OR IGNORE INTO yoyo_graph_edges(from_id,to_id,kind,note,created_at) VALUES(?,?,?,?,?)').run(from, to, kind, String(note).slice(0, 200), now)
    let nodes = 0
    for (const activity of this.social.activities(viewId)) {
      const activityNode = this.nodeId('activity', activity.activityId)
      put(activityNode, 'activity', activity.activityId, activity.activityId, activity.goal)
      nodes++
      for (const intent of this.intents.list({ activityId: activity.activityId, limit: 50 })) {
        const intentNode = this.nodeId('intent', intent.id)
        put(intentNode, 'intent', intent.id, activity.activityId, intent.goal + ' · ' + intent.state)
        edge(intentNode, activityNode, 'derived_from', intent.why)
        nodes++
        for (const dependency of intent.dependsOn){
          const target = this.intents.get(dependency)
          if (!target) continue
          put(this.nodeId('intent', target.id), 'intent', target.id, target.activity_id, target.goal + ' · ' + target.state)
          edge(intentNode, this.nodeId('intent', target.id), 'depends_on')
        }
        if (!intent.task_id) continue
        let task = null
        try { task = this.tasks.inspect(intent.task_id, viewId) } catch { continue }
        const taskNode = this.nodeId('task', task.id)
        put(taskNode, 'task', task.id, activity.activityId, task.role + ' · ' + task.state)
        edge(taskNode, intentNode, 'derived_from')
        nodes++
        for (const entry of this.tasks.board(viewId, { taskId: task.id, limit: 50 })) {
          const evidenceNode = this.nodeId('observation', entry.id)
          put(evidenceNode, 'observation', entry.id, activity.activityId, entry.kind + ' · ' + (entry.source ?? ''))
          edge(evidenceNode, taskNode, 'produced', entry.source)
          nodes++
          for (const ruling of this.db.prepare('SELECT id,decision,chosen_body,reason FROM yoyo_team_source_decisions WHERE source=?').all(String(entry.source))) {
            const decisionNode = this.nodeId('decision', 'source:' + ruling.id)
            put(decisionNode, 'decision', 'source:' + ruling.id, activity.activityId, ruling.decision)
            // A refuted reading and an unresolved one are not support: the graph
            // keeps the disagreement visible instead of flattening it.
            if (ruling.decision === 'verified') edge(decisionNode, evidenceNode, 'supports', ruling.reason)
            else if (ruling.decision === 'refuted') edge(decisionNode, evidenceNode, 'contradicts', ruling.reason)
            nodes++
          }
        }
      }
      for (const event of this.tasks.activityEvents(viewId, { activityId: activity.activityId, limit: 20 })) {
        if (event.kind !== 'direction_changed') continue
        const node = this.nodeId('decision', 'direction:' + event.eventId)
        put(node, 'decision', 'direction:' + event.eventId, activity.activityId, '方向变更')
        edge(node, activityNode, 'supersedes', event.body)
        nodes++
      }
      for (const row of this.db.prepare('SELECT id,state FROM yoyo_jobs WHERE scopes=? ORDER BY created_at DESC LIMIT 20').all(scopes)) {
        const node = this.nodeId('artifact', row.id)
        put(node, 'artifact', row.id, activity.activityId, '作业 · ' + row.state)
        edge(node, activityNode, 'produced')
        nodes++
      }
    }
    return { nodes }
  }
  // The five questions the plan asks the graph to answer, in one scope-checked
  // read. Bodies stay short: this is an index with references, not a transcript.
  why(viewId, { activityId = null, limit = 8 } = {}) {
    this.sync(viewId)
    const view = this.social.view(viewId)
    const activities = this.social.activities(viewId).filter(activity => !activityId || activity.activityId === activityId)
    const answer = []
    for (const activity of activities.slice(0, limit)) {
      const intents = this.intents.list({ activityId: activity.activityId, limit: 20 })
      const tasks = []
      for (const intent of intents) {
        if (!intent.task_id) continue
        try { tasks.push(this.tasks.inspect(intent.task_id, viewId)) } catch { /* revoked work is not evidence */ }
      }
      const taskIds = new Set(tasks.map(task => task.id))
      const rulings = this.db.prepare('SELECT source,decision,chosen_body,reason,created_at FROM yoyo_team_source_decisions WHERE view_id=? ORDER BY id DESC LIMIT 20').all(viewId)
        .filter(row => row.source && this.tasks.searchEvidence(viewId, { query: row.source, kind: 'source', limit: 5 }).length)
      answer.push({
        activityId: activity.activityId,
        goal: activity.goal,
        why: activity.why ?? '',
        directionChanges: this.tasks.activityEvents(viewId, { activityId: activity.activityId, limit: 20 }).filter(event => event.kind === 'direction_changed')
          .map(event => ({ at: event.at, body: event.body, baseRevision: event.baseRevision })),
        verified: rulings.map(row => ({ source: row.source, decision: row.decision, chosen: row.chosen_body, reason: row.reason })),
        unresolved: rulings.filter(row => row.decision === 'unresolved').map(row => row.source),
        unknowns: {
          openQuestions: this.tasks.openQuestions(viewId, { activityId: activity.activityId }),
          blockedIntents: intents.filter(intent => intent.state === 'blocked').map(intent => ({ id: intent.id, goal: intent.goal })),
          queuedIntents: intents.filter(intent => intent.state === 'ready').map(intent => ({ id: intent.id, goal: intent.goal })),
        },
        dependsOn: intents.flatMap(intent => intent.dependsOn.map(dependency => ({ intentId: intent.id, dependsOn: dependency }))),
        branchStates: tasks.map(task => ({ taskId: task.id, role: task.role, state: task.state })),
        evidenceCount: tasks.reduce((total, task) => total + this.tasks.board(viewId, { taskId: task.id, limit: 50 }).length, 0),
      })
    }
    return { view: { focus: view.focus, scopes: view.scopes }, activities: answer, note: '图是索引：正文与原始回执仍在任务证据板、事件与裁定里；这里不保存模型隐藏推理。' }
  }
  // Console/post-mortem view: nodes and edges only, no bodies.
  shape(viewId, { activityId = null, limit = 60 } = {}) {
    this.sync(viewId)
    const nodes = this.db.prepare('SELECT id,kind,ref,activity_id,label FROM yoyo_graph_nodes WHERE activity_id IS NULL OR activity_id=? ORDER BY created_at DESC LIMIT ?').all(activityId, Math.min(200, limit))
    const ids = new Set(nodes.map(node => node.id))
    const edges = this.db.prepare('SELECT from_id,to_id,kind FROM yoyo_graph_edges').all().filter(edge => ids.has(edge.from_id) && ids.has(edge.to_id))
    return { nodes, edges }
  }
}
