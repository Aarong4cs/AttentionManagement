import assert from 'node:assert/strict'
import {
  zonedInstant, zonedDayStart, zonedDayEnd, addDays, startOfWeek, clippedMs,
} from '../src/lib/time.ts'
import {
  rankBetween, ranksBetween, rankAppend, byRank,
} from '../src/lib/rank.ts'

const TZ = 'America/New_York'
let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok  ' + name) }

console.log('\nDST: 2026-03-08 is US spring-forward')
check('09:00 before the change is EST (UTC-5)', () => {
  assert.equal(zonedInstant('2026-03-07', '09:00:00', TZ).toISOString(),
               '2026-03-07T14:00:00.000Z')
})
check('09:00 after the change is EDT (UTC-4) — same wall clock, different instant', () => {
  assert.equal(zonedInstant('2026-03-09', '09:00:00', TZ).toISOString(),
               '2026-03-09T13:00:00.000Z')
})
check('the transition day is 23 hours long', () => {
  const start = zonedDayStart('2026-03-08', TZ)
  const end = zonedDayEnd('2026-03-08', TZ)
  assert.equal(end - start, 23 * 3600_000)
})
check('an ordinary day is 24 hours long', () => {
  assert.equal(zonedDayEnd('2026-06-10', TZ) - zonedDayStart('2026-06-10', TZ),
               24 * 3600_000)
})
check('autumn fall-back day is 25 hours long', () => {
  assert.equal(zonedDayEnd('2026-11-01', TZ) - zonedDayStart('2026-11-01', TZ),
               25 * 3600_000)
})

console.log('\nmidnight clipping')
check('a 23:40 -> 00:20 block splits 20/20 across two day columns', () => {
  const start = new Date('2026-06-10T23:40:00Z')
  const end   = new Date('2026-06-11T00:20:00Z')
  const d1s = new Date('2026-06-10T00:00:00Z'), d1e = new Date('2026-06-11T00:00:00Z')
  const d2s = d1e,                              d2e = new Date('2026-06-12T00:00:00Z')
  assert.equal(clippedMs(start, end, d1s, d1e), 20 * 60_000)
  assert.equal(clippedMs(start, end, d2s, d2e), 20 * 60_000)
  assert.equal(end - start, 40 * 60_000, 'the entry itself is one 40-minute interval')
})
check('a block outside the window contributes nothing', () => {
  assert.equal(clippedMs(new Date('2026-06-09T10:00:00Z'), new Date('2026-06-09T11:00:00Z'),
                         new Date('2026-06-10T00:00:00Z'), new Date('2026-06-11T00:00:00Z')), 0)
})

console.log('\ndate helpers')
check('addDays crosses a month boundary', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})
check('startOfWeek(Monday=1)', () => {
  assert.equal(startOfWeek('2026-09-08', 1), '2026-09-07') // Tue -> Mon
  assert.equal(startOfWeek('2026-09-07', 1), '2026-09-07') // Mon -> itself
  assert.equal(startOfWeek('2026-09-13', 1), '2026-09-07') // Sun -> prior Mon
})

console.log('\nfractional ranking')
check('a key between two neighbours sorts between them', () => {
  const a = rankBetween(null, null)
  const c = rankBetween(a, null)
  const b = rankBetween(a, c)
  assert.ok(a < b && b < c, `expected ${a} < ${b} < ${c}`)
})
check('50 consecutive same-spot insertions stay strictly ordered', () => {
  let lo = rankBetween(null, null)
  const hi = rankBetween(lo, null)
  let prev = lo
  for (let i = 0; i < 50; i++) {
    const mid = rankBetween(prev, hi)
    assert.ok(prev < mid && mid < hi, `broke at ${i}: ${prev} !< ${mid} !< ${hi}`)
    prev = mid
  }
})
check('ranksBetween returns n ordered keys', () => {
  const ks = ranksBetween(null, null, 5)
  assert.equal(ks.length, 5)
  assert.deepEqual([...ks].sort(), ks, 'keys are already in ascending byte order')
})
check('rankAppend sorts after everything', () => {
  const ks = ranksBetween(null, null, 3)
  const next = rankAppend(ks)
  assert.ok(next > ks[ks.length - 1])
})
check('byRank breaks ties on id, matching ORDER BY rank, id', () => {
  const rows = [
    { id: 'b', rank: 'a0' }, { id: 'a', rank: 'a0' }, { id: 'c', rank: 'a1' },
  ]
  assert.deepEqual(rows.sort(byRank).map(r => r.id), ['a', 'b', 'c'])
})


import { layoutDay, nowOffset } from '../src/lib/layout.ts'

const D = (s) => new Date(s)
const DAY_S = D('2026-06-10T00:00:00Z')
const DAY_E = D('2026-06-11T00:00:00Z')
const NOW = D('2026-06-10T12:00:00Z')

const blk = (id, start, end, kind = 'trailed') => ({
  kind, id, taskId: id, title: id,
  start: D(start), end: end === null ? null : D(end),
  running: end === null, completed: false, edited: false, color: null,
})

console.log('\nday layout')
check('positions a block as a fraction of the column', () => {
  const [p] = layoutDay([blk('a', '2026-06-10T06:00:00Z', '2026-06-10T12:00:00Z')],
                        DAY_S, DAY_E, NOW)
  assert.equal(p.top, 0.25)
  assert.equal(p.height, 0.25)
  assert.equal(p.lanes, 1)
})
check('clips a block that starts before the column', () => {
  const [p] = layoutDay([blk('a', '2026-06-09T22:00:00Z', '2026-06-10T06:00:00Z')],
                        DAY_S, DAY_E, NOW)
  assert.equal(p.top, 0)
  assert.equal(p.height, 0.25)
})
check('a running block grows to now, not past it', () => {
  const [p] = layoutDay([blk('a', '2026-06-10T06:00:00Z', null)], DAY_S, DAY_E, NOW)
  assert.equal(p.top, 0.25)
  assert.equal(p.height, 0.25, 'ends at NOW = 12:00')
})
check('drops a block that misses the column entirely', () => {
  assert.equal(layoutDay([blk('a', '2026-06-12T06:00:00Z', '2026-06-12T07:00:00Z')],
                         DAY_S, DAY_E, NOW).length, 0)
})
check('overlapping blocks get side-by-side lanes', () => {
  const ps = layoutDay([
    blk('a', '2026-06-10T06:00:00Z', '2026-06-10T08:00:00Z'),
    blk('b', '2026-06-10T07:00:00Z', '2026-06-10T09:00:00Z'),
  ], DAY_S, DAY_E, NOW)
  assert.equal(ps.length, 2)
  assert.deepEqual(ps.map(p => p.lane), [0, 1])
  assert.ok(ps.every(p => p.lanes === 2))
})
check('non-overlapping blocks share one lane', () => {
  const ps = layoutDay([
    blk('a', '2026-06-10T06:00:00Z', '2026-06-10T07:00:00Z'),
    blk('b', '2026-06-10T08:00:00Z', '2026-06-10T09:00:00Z'),
  ], DAY_S, DAY_E, NOW)
  assert.ok(ps.every(p => p.lanes === 1 && p.lane === 0))
})
check('a separate collision does not widen an earlier cluster', () => {
  const ps = layoutDay([
    blk('a', '2026-06-10T01:00:00Z', '2026-06-10T02:00:00Z'),
    blk('b', '2026-06-10T01:30:00Z', '2026-06-10T02:30:00Z'),
    blk('c', '2026-06-10T10:00:00Z', '2026-06-10T11:00:00Z'),
  ], DAY_S, DAY_E, NOW)
  const byId = Object.fromEntries(ps.map(p => [p.block.id, p]))
  assert.equal(byId.a.lanes, 2)
  assert.equal(byId.b.lanes, 2)
  assert.equal(byId.c.lanes, 1, 'the lone afternoon block keeps full width')
})
check('a scheduled block sorts behind a trailed one starting at the same time', () => {
  const ps = layoutDay([
    blk('t', '2026-06-10T06:00:00Z', '2026-06-10T07:00:00Z', 'trailed'),
    blk('s', '2026-06-10T06:00:00Z', '2026-06-10T07:00:00Z', 'scheduled'),
  ], DAY_S, DAY_E, NOW)
  assert.equal(ps[0].block.kind, 'scheduled')
})
check('nowOffset locates the marker, and is null off-day', () => {
  assert.equal(nowOffset(DAY_S, DAY_E, NOW), 0.5)
  assert.equal(nowOffset(DAY_S, DAY_E, D('2026-06-12T00:00:00Z')), null)
})



import { insertionIndex } from '../src/lib/layout.ts'

console.log('\ndrag insertion')
const MIDS = [10, 30, 50, 70]
check('above everything lands at 0', () => {
  assert.equal(insertionIndex(MIDS, 0), 0)
  assert.equal(insertionIndex(MIDS, 9), 0)
})
check('below everything lands at the end', () => {
  assert.equal(insertionIndex(MIDS, 999), 4)
})
check('between two rows lands between them', () => {
  assert.equal(insertionIndex(MIDS, 31), 2)
  assert.equal(insertionIndex(MIDS, 49), 2)
})
check('exactly on a midpoint stays above it', () => {
  assert.equal(insertionIndex(MIDS, 30), 1)
})
check('an empty list always lands at 0', () => {
  assert.equal(insertionIndex([], 500), 0)
})



import { applyOps, buildBlocks, emptySnapshot } from '../src/lib/offline.ts'

const task = (id, over = {}) => ({
  id, user_id: 'u', title: id, notes: null, due_at: null, estimated_minutes: null,
  rank: id, completed_at: null, deleted_at: null, recurrence_id: null,
  occurrence_date: null, detached: false, scheduled_end: null, color: null, priority: null,
  created_at: '2026-06-10T00:00:00Z', updated_at: '2026-06-10T00:00:00Z', ...over,
})
const snap = (over = {}) => ({ ...emptySnapshot, ...over })

console.log('\noffline queue')
check('createTask appears immediately', () => {
  const s = applyOps(snap(), [{ op: 'createTask', at: 'x', task: task('a') }])
  assert.deepEqual(s.tasks.map(t => t.id), ['a'])
})
check('moveTask updates the rank in place', () => {
  const s = applyOps(snap({ tasks: [task('a'), task('b')] }),
                     [{ op: 'moveTask', at: 'x', taskId: 'a', rank: 'zz' }])
  assert.equal(s.tasks.find(t => t.id === 'a').rank, 'zz')
})
check('deleteTask removes the row from the view', () => {
  const s = applyOps(snap({ tasks: [task('a'), task('b')] }),
                     [{ op: 'deleteTask', at: '2026-06-10T01:00:00Z', taskId: 'a' }])
  assert.deepEqual(s.tasks.map(t => t.id), ['b'])
})
check('startTrail makes the task appear to be running at once', () => {
  const s = applyOps(snap({ tasks: [task('a')] }), [
    { op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a', startedAt: '2026-06-10T09:00:00Z' },
  ])
  assert.equal(s.running.id, 'e1')
  assert.equal(s.entries.length, 1)
  assert.equal(s.entries[0].ended_at, null)
  assert.equal(s.entries[0].title, 'a', 'title is carried so the block can be drawn offline')
})
check('stopTrail closes it and clears the running slot', () => {
  const s = applyOps(snap({ tasks: [task('a')] }), [
    { op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a', startedAt: '2026-06-10T09:00:00Z' },
    { op: 'stopTrail', at: 'x', entryId: 'e1', endedAt: '2026-06-10T10:00:00Z' },
  ])
  assert.equal(s.running, null)
  assert.equal(s.entries[0].ended_at, '2026-06-10T10:00:00Z')
})
check('completing mirrors the auto-stop trigger, at completed_at not now', () => {
  const s = applyOps(snap({ tasks: [task('a')] }), [
    { op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a', startedAt: '2026-06-10T09:00:00Z' },
    { op: 'completeTask', at: 'x', taskId: 'a', completedAt: '2026-06-10T09:45:00Z' },
  ])
  assert.equal(s.running, null, 'the timer must not still look like it is running')
  assert.equal(s.entries[0].ended_at, '2026-06-10T09:45:00Z')
})
check('uncompleting does not reopen the closed entry', () => {
  const s = applyOps(snap({ tasks: [task('a')] }), [
    { op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a', startedAt: '2026-06-10T09:00:00Z' },
    { op: 'completeTask', at: 'x', taskId: 'a', completedAt: '2026-06-10T09:45:00Z' },
    { op: 'uncompleteTask', at: 'x', taskId: 'a' },
  ])
  assert.equal(s.entries[0].ended_at, '2026-06-10T09:45:00Z')
  assert.equal(s.running, null)
  assert.equal(s.tasks[0].completed_at, null)
})
check('clearCompleted removes exactly the listed rows', () => {
  const s = applyOps(
    snap({ tasks: [task('a', { completed_at: 'x' }), task('b')] }),
    [{ op: 'clearCompleted', at: '2026-06-10T01:00:00Z', taskIds: ['a'] }])
  assert.deepEqual(s.tasks.map(t => t.id), ['b'])
})
check('ops apply in order and compose', () => {
  const s = applyOps(snap(), [
    { op: 'createTask', at: 'x', task: task('a') },
    { op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a', startedAt: '2026-06-10T09:00:00Z' },
    { op: 'moveTask', at: 'x', taskId: 'a', rank: 'q' },
  ])
  assert.equal(s.tasks[0].rank, 'q')
  assert.equal(s.running.task_id, 'a')
})
check('applyOps does not mutate the snapshot it was given', () => {
  const before = snap({ tasks: [task('a')] })
  applyOps(before, [{ op: 'deleteTask', at: 'x', taskId: 'a' }])
  assert.equal(before.tasks.length, 1, 'the cached snapshot must survive intact')
})
check('buildBlocks derives both kinds from rows', () => {
  const s = applyOps(snap({
    rangeTasks: [task('s', { due_at: '2026-06-10T13:00:00Z', estimated_minutes: 30,
                             scheduled_end: '2026-06-10T13:30:00Z' })],
    tasks: [task('a')],
  }), [{ op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a', startedAt: '2026-06-10T09:00:00Z' }])
  const blocks = buildBlocks(s)
  assert.equal(blocks.filter(b => b.kind === 'scheduled').length, 1)
  const trailed = blocks.find(b => b.kind === 'trailed')
  assert.equal(trailed.running, true)
  assert.equal(trailed.end, null)
})



import { formatRange } from '../src/lib/time.ts'

console.log('\nblock time ranges')
const TZNY = 'America/New_York'
check('collapses a shared meridiem', () => {
  assert.equal(
    formatRange(D('2026-06-10T13:00:00Z'), D('2026-06-10T13:30:00Z'), TZNY, 'en-US'),
    '9:00–9:30 AM')
})
check('keeps both when they differ', () => {
  assert.equal(
    formatRange(D('2026-06-10T15:30:00Z'), D('2026-06-10T17:00:00Z'), TZNY, 'en-US'),
    '11:30 AM–1:00 PM')
})
check('a running block reads as ending now', () => {
  assert.equal(
    formatRange(D('2026-06-10T13:00:00Z'), null, TZNY, 'en-US'),
    '9:00 AM–now')
})
check('spans midnight without wrapping to a date', () => {
  assert.equal(
    formatRange(D('2026-06-11T03:40:00Z'), D('2026-06-11T04:20:00Z'), TZNY, 'en-US'),
    '11:40 PM–12:20 AM')
})
check('a 24-hour locale renders the afternoon as 24-hour', () => {
  // 17:00Z is 1pm in New York
  assert.equal(
    formatRange(D('2026-06-10T17:00:00Z'), D('2026-06-10T17:30:00Z'), TZNY, 'en-GB'),
    '13:00–13:30')
  assert.equal(
    formatRange(D('2026-06-10T17:00:00Z'), D('2026-06-10T17:30:00Z'), TZNY, 'en-US'),
    '1:00–1:30 PM')
})
check('morning and evening never render identically', () => {
  // a 12-hour clock without a meridiem would make 9am and 9pm the same string
  for (const loc of ['en-US', 'en-GB']) {
    const morning = formatRange(D('2026-06-10T13:00:00Z'), null, TZNY, loc) // 9am NY
    const evening = formatRange(D('2026-06-11T01:00:00Z'), null, TZNY, loc) // 9pm NY
    assert.notEqual(morning, evening, `${loc}: ${morning} vs ${evening}`)
  }
})



// `snap` is already a local fixture helper above
import { dragBlock, minutesBetween, snap as snapMs } from '../src/lib/layout.ts'

console.log('\ndragging a block')
const S = D('2026-06-10T13:00:00Z')
const E = D('2026-06-10T14:00:00Z')
const MIN = 60_000

check('snaps to five minutes', () => {
  assert.equal(new Date(snapMs(D('2026-06-10T13:02:00Z').getTime())).toISOString(),
               '2026-06-10T13:00:00.000Z')
  assert.equal(new Date(snapMs(D('2026-06-10T13:03:00Z').getTime())).toISOString(),
               '2026-06-10T13:05:00.000Z')
})
check('moving keeps the duration', () => {
  const r = dragBlock(S, E, 30 * MIN, 'move')
  assert.equal(r.start.toISOString(), '2026-06-10T13:30:00.000Z')
  assert.equal(r.end.toISOString(), '2026-06-10T14:30:00.000Z')
  assert.equal(minutesBetween(r.start, r.end), 60)
})
check('moving backwards works too', () => {
  const r = dragBlock(S, E, -90 * MIN, 'move')
  assert.equal(r.start.toISOString(), '2026-06-10T11:30:00.000Z')
  assert.equal(minutesBetween(r.start, r.end), 60)
})
check('dragging the end resizes only the end', () => {
  const r = dragBlock(S, E, 30 * MIN, 'end')
  assert.equal(r.start.toISOString(), S.toISOString())
  assert.equal(minutesBetween(r.start, r.end), 90)
})
check('dragging the start resizes only the start', () => {
  const r = dragBlock(S, E, 15 * MIN, 'start')
  assert.equal(r.end.toISOString(), E.toISOString())
  assert.equal(minutesBetween(r.start, r.end), 45)
})
check('an end cannot be dragged above its start', () => {
  const r = dragBlock(S, E, -600 * MIN, 'end')
  assert.ok(r.end > r.start, `${r.start.toISOString()} .. ${r.end.toISOString()}`)
  assert.equal(minutesBetween(r.start, r.end), 5, 'clamped to the minimum')
})
check('a start cannot be dragged below its end', () => {
  const r = dragBlock(S, E, 600 * MIN, 'start')
  assert.ok(r.end > r.start)
  assert.equal(minutesBetween(r.start, r.end), 5)
})
check('snapping survives a drag that lands mid-step', () => {
  const r = dragBlock(S, E, 7 * MIN, 'move')
  assert.equal(r.start.toISOString(), '2026-06-10T13:05:00.000Z')
})



console.log('\napplying ops over their own result')
check('createTask does not duplicate a task already in the snapshot', () => {
  const t = task('a')
  const op = { op: 'createTask', at: 'x', task: t }
  // the snapshot arrives from the server already containing it
  const s = applyOps(snap({ tasks: [t] }), [op])
  assert.equal(s.tasks.filter(x => x.id === 'a').length, 1)
})
check('startTrail does not duplicate an entry already in the snapshot', () => {
  const entry = {
    id: 'e1', user_id: 'u', task_id: 'a', started_at: '2026-06-10T09:00:00Z',
    ended_at: null, edited_at: null, deleted_at: null,
    created_at: 'x', updated_at: 'x', duration_seconds: null,
    title: 'a', taskCompleted: false, color: null,
  }
  const op = { op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a',
               startedAt: '2026-06-10T09:00:00Z' }
  const s = applyOps(snap({ tasks: [task('a')], entries: [entry] }), [op])
  assert.equal(s.entries.filter(e => e.id === 'e1').length, 1)
  assert.equal(s.running.id, 'e1', 'still recognised as the running one')
})
check('a stopped entry from the server is not resurrected as running', () => {
  const stopped = {
    id: 'e1', user_id: 'u', task_id: 'a', started_at: '2026-06-10T09:00:00Z',
    ended_at: '2026-06-10T10:00:00Z', edited_at: null, deleted_at: null,
    created_at: 'x', updated_at: 'x', duration_seconds: 3600,
    title: 'a', taskCompleted: false, color: null,
  }
  const s = applyOps(snap({ tasks: [task('a')], entries: [stopped] }), [
    { op: 'startTrail', at: 'x', entryId: 'e1', taskId: 'a', startedAt: '2026-06-10T09:00:00Z' },
  ])
  assert.equal(s.running, null)
})



console.log('\ncreating on the timeline')
check('a scheduled task goes to the timeline, not the sequence', () => {
  const scheduled = task('s', {
    due_at: '2026-06-10T16:00:00Z',
    estimated_minutes: 30,
    scheduled_end: '2026-06-10T16:30:00Z',
  })
  const s = applyOps(snap(), [{ op: 'createTask', at: 'x', task: scheduled }])
  assert.equal(s.tasks.length, 0, 'must not appear in the sequence pane')
  assert.equal(s.rangeTasks.length, 1)
  assert.equal(buildBlocks(s).filter(b => b.kind === 'scheduled').length, 1,
               'and draws immediately rather than after a round trip')
})
check('a task with no due date still goes to the sequence', () => {
  const s = applyOps(snap(), [{ op: 'createTask', at: 'x', task: task('a') }])
  assert.equal(s.tasks.length, 1)
  assert.equal(s.rangeTasks.length, 0)
})
check('a scheduled task already returned by the server is not duplicated', () => {
  const scheduled = task('s', {
    due_at: '2026-06-10T16:00:00Z', estimated_minutes: 30,
    scheduled_end: '2026-06-10T16:30:00Z',
  })
  const s = applyOps(snap({ rangeTasks: [scheduled] }),
                     [{ op: 'createTask', at: 'x', task: scheduled }])
  assert.equal(s.rangeTasks.length, 1)
})



import { mapEvent, syncWindow, windowChanged } from '../src/lib/gcal.ts'

console.log('\ngoogle calendar mapping')
const ev = (over = {}) => ({
  id: 'e1', status: 'confirmed', summary: 'Standup', etag: '"abc"',
  start: { dateTime: '2026-06-10T13:00:00Z' },
  end: { dateTime: '2026-06-10T13:30:00Z' }, ...over,
})

check('a timed event becomes a scheduled task', () => {
  const m = mapEvent(ev())
  assert.equal(m.kind, 'task')
  assert.equal(m.task.title, 'Standup')
  assert.equal(m.task.due_at, '2026-06-10T13:00:00.000Z')
  assert.equal(m.task.estimated_minutes, 30)
  assert.equal(m.task.external_etag, '"abc"')
})
check('a cancelled event maps to a delete', () => {
  const m = mapEvent(ev({ status: 'cancelled' }))
  assert.equal(m.kind, 'delete')
  assert.equal(m.externalId, 'e1')
})
check('an all-day event is skipped, not stretched over a column', () => {
  const m = mapEvent(ev({ start: { date: '2026-06-10' }, end: { date: '2026-06-11' } }))
  assert.equal(m.kind, 'skip')
})
check('an untitled event still satisfies the title CHECK', () => {
  const m = mapEvent(ev({ summary: undefined }))
  assert.equal(m.kind, 'task')
  assert.ok(m.task.title.length >= 1)
})
check('a very long title is truncated below the CHECK limit', () => {
  const m = mapEvent(ev({ summary: 'x'.repeat(900) }))
  assert.ok(m.task.title.length <= 500)
})
check('a multi-day timed event is clamped to the CHECK ceiling', () => {
  const m = mapEvent(ev({ end: { dateTime: '2026-06-13T13:00:00Z' } }))
  assert.equal(m.kind, 'task')
  assert.equal(m.task.estimated_minutes, 1440, 'would otherwise violate the CHECK')
})
check('a zero-length event is skipped', () => {
  assert.equal(mapEvent(ev({ end: { dateTime: '2026-06-10T13:00:00Z' } })).kind, 'skip')
})
check('an event crossing a DST boundary keeps its absolute instants', () => {
  // 09:00 EST -> 14:00Z; the mapping stores instants, so the timeline's own
  // zone handling decides where it lands
  const m = mapEvent(ev({
    start: { dateTime: '2026-03-07T14:00:00Z' },
    end: { dateTime: '2026-03-07T14:30:00Z' },
  }))
  assert.equal(m.task.due_at, '2026-03-07T14:00:00.000Z')
  assert.equal(m.task.estimated_minutes, 30)
})

console.log('\ngoogle sync window')
check('snaps to month boundaries', () => {
  const w = syncWindow(D('2026-09-11T12:00:00Z'))
  assert.equal(w.windowStart, '2026-08-01')
  assert.equal(w.windowEnd, '2026-12-31')
})
check('is stable across a whole month, so the sync token survives', () => {
  const a = syncWindow(D('2026-09-01T00:00:00Z'))
  const b = syncWindow(D('2026-09-30T23:00:00Z'))
  assert.deepEqual([a.windowStart, a.windowEnd], [b.windowStart, b.windowEnd])
})
check('moves when the month does', () => {
  const sep = syncWindow(D('2026-09-15T00:00:00Z'))
  const oct = syncWindow(D('2026-10-01T00:00:00Z'))
  assert.notDeepEqual([sep.windowStart, sep.windowEnd], [oct.windowStart, oct.windowEnd])
  assert.ok(windowChanged({ windowStart: sep.windowStart, windowEnd: sep.windowEnd }, oct))
})
check('a never-synced calendar counts as changed', () => {
  const w = syncWindow(D('2026-09-15T00:00:00Z'))
  assert.ok(windowChanged({ windowStart: null, windowEnd: null }, w))
})
check('handles a December window rolling into next year', () => {
  const w = syncWindow(D('2026-12-15T00:00:00Z'))
  assert.equal(w.windowStart, '2026-11-01')
  assert.equal(w.windowEnd, '2027-03-31')
})

console.log(`\n${n} assertions passed\n`)
