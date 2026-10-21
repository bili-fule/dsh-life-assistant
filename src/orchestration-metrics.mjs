import { localParts } from './time.mjs'

// Orchestration is judged by measured numbers, not by the shape of the code. The
// counters below are facts the host observed itself: a heavy tool the subject
// really called, a step an executor really ran, an event that was really handed
// over and when. A quantity the runtime did not report stays absent; it is never
// written as a measured zero, because "no meter" and "free" are different claims.
export const METRIC_UNITS = ['count', 'ms', 'tokens']

export class OrchestrationMetrics {
  constructor(db, clock = Date.now) {
    this.db = db;this.clock = clock
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yoyo_metric_counters(
        kind TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, PRIMARY KEY(kind, day));
      CREATE TABLE IF NOT EXISTS yoyo_metric_timings(
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ms INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS yoyo_metric_samples(
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value INTEGER, unit TEXT NOT NULL,
        reported INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
    `)
  }
  // Kind names are host constants, never model input: a branch cannot invent a
  // metric that looks like a measured capability.
  count(kind, n = 1, day = localParts(this.clock()).date) {
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_:.-]{2,60}$/.test(kind)) throw Error('计量键无效')
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw Error('计量增量无效')
    this.db.prepare(`INSERT INTO yoyo_metric_counters(kind,day,count,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(kind,day) DO UPDATE SET count=count+excluded.count,updated_at=excluded.updated_at`)
      .run(kind, day, n, this.clock())
    return { kind, day, count: this.db.prepare('SELECT count FROM yoyo_metric_counters WHERE kind=? AND day=?').get(kind, day).count }
  }
  time(kind, ms) {
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_:.-]{2,60}$/.test(kind)) throw Error('计量键无效')
    // A negative duration can only come from a clock jump; drop it instead of
    // pretending the transfer was instantaneous.
    if (!Number.isFinite(ms) || ms < 0) return null
    const rounded = Math.round(Math.min(ms, 86400000))
    this.db.prepare('INSERT INTO yoyo_metric_timings(kind,ms,at) VALUES(?,?,?)').run(kind, rounded, this.clock())
    return { kind, ms: rounded }
  }
  // For quantities the host cannot measure (token usage without a meter), record
  // the absence explicitly so a report cannot silently show 0.
  sample(kind, { value = null, unit = 'tokens', reported = false, note = '' } = {}) {
    if (!METRIC_UNITS.includes(unit)) throw Error('计量单位无效')
    const known = reported && Number.isSafeInteger(value) && value >= 0
    this.db.prepare('INSERT INTO yoyo_metric_samples(kind,value,unit,reported,note,at) VALUES(?,?,?,?,?,?)')
      .run(kind, known ? value : null, unit, known ? 1 : 0, String(note).slice(0, 200), this.clock())
    return { kind, value: known ? value : null, unit, reported: known }
  }
  percentile(values, ratio) {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
    return sorted[index]
  }
  summary({ day = localParts(this.clock()).date } = {}) {
    const counts = Object.fromEntries(this.db.prepare('SELECT kind,count FROM yoyo_metric_counters WHERE day=?').all(day).map(row => [row.kind, row.count]))
    const timings = {}
    for (const kind of this.db.prepare('SELECT DISTINCT kind FROM yoyo_metric_timings').all().map(row => row.kind)) {
      const values = this.db.prepare('SELECT ms FROM yoyo_metric_timings WHERE kind=? ORDER BY ms').all(kind).map(row => row.ms)
      if (!values.length) continue
      timings[kind] = { samples: values.length, p50: this.percentile(values, 0.5), p95: this.percentile(values, 0.95), max: values[values.length - 1] }
    }
    const samples = this.db.prepare('SELECT kind,value,unit,reported,note,at FROM yoyo_metric_samples ORDER BY id DESC LIMIT 10').all()
      .map(row => ({ kind: row.kind, value: row.value, unit: row.unit, reported: !!row.reported, note: row.note, at: row.at }))
    return { day, counts, timings, samples }
  }
}
