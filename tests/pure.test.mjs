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
  running: end === null, completed: false, edited: false,
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

console.log(`\n${n} assertions passed\n`)
