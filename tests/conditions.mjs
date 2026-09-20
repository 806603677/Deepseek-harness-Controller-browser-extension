import assert from 'node:assert/strict'
import { conditionOptions, pollCondition } from '../extension/conditions.js'
import { SnapshotCache } from '../extension/snapshot-cache.js'

let clock = 0
const timing = { now: () => clock, sleep: async ms => { clock += ms } }
const delayed = await pollCondition(async () => ({ met: clock >= 300, actual: clock }), { target: '#ready' }, timing)
assert.equal(delayed.elapsedMs, 300)
assert.equal(delayed.attempts, 4)
await assert.rejects(pollCondition(async () => ({ met: false, actual: 'loading' }),
  { target: '#result', condition: 'text', equals: 'done', timeoutMs: 50 }, timing), error => {
  assert.equal(error.code, 'CONDITION_TIMEOUT')
  assert.equal(error.details.expected, 'done')
  assert.equal(error.details.actual, 'loading')
  return true
})
assert.throws(() => conditionOptions({ target: '#x', timeoutMs: NaN }))
assert.throws(() => conditionOptions({ target: '#x', condition: 'value' }))
assert.throws(() => conditionOptions({ target: '#x', condition: 'checked', equals: 'true' }))
assert.throws(() => conditionOptions({ target: '#x', condition: 'count', equals: -1 }))
assert.throws(() => conditionOptions({ target: '#x', condition: 'text', equals: 'a', includes: 'a' }))
let moving = 0
const stable = await pollCondition(async () => {
  moving++
  return { met: true, actual: { locator: '#button', geometry: [moving < 3 ? moving : 3] } }
}, { target: '#button', condition: 'clickable' }, timing)
assert.equal(stable.attempts, 4, 'click waits for matching consecutive geometry samples')

let id = 0, now = 0
const cache = new SnapshotCache({ id: () => String(++id), now: () => now, maxEntries: 3, ttlMs: 100 })
const snapshot = (elements, documentKey = 'doc1', truncated = false) => ({ mode: 'compact', elements, documentKey, truncated, elementsCount: elements.length })
const first = cache.capture(1, snapshot([{ locator: '#a', text: 'old' }, { locator: '#b' }]))
assert.equal('documentKey' in first, false)
const delta = cache.capture(1, snapshot([{ locator: '#a', text: 'new' }, { locator: '#c' }]), { since: first.snapshotId })
assert.deepEqual(delta.changed, [{ locator: '#a', text: 'new' }])
assert.deepEqual(delta.added, [{ locator: '#c' }])
assert.deepEqual(delta.removed, ['#b'])
assert.equal(cache.capture(2, snapshot([]), { since: delta.snapshotId }).resetReason, 'baseline_missing')
assert.equal(cache.capture(1, snapshot([], 'doc2'), { since: delta.snapshotId }).resetReason, 'page_changed')
const limited = cache.capture(1, snapshot([], 'doc1', true))
assert.equal(cache.capture(1, snapshot([]), { since: limited.snapshotId }).resetReason, 'truncated_snapshot')
const scoped = cache.capture(1, snapshot([]), { scope: '#one' })
assert.equal(cache.capture(1, snapshot([]), { scope: '#two', since: scoped.snapshotId }).resetReason, 'options_changed')
now = 101
assert.equal(cache.capture(1, snapshot([]), { since: scoped.snapshotId }).resetReason, 'baseline_missing')
const last = cache.capture(1, snapshot([]))
cache.clearTab(1)
assert.equal(cache.capture(1, snapshot([]), { since: last.snapshotId }).resetReason, 'baseline_missing')
assert.ok(cache.entries.size <= 3)
process.stdout.write('conditions, stable clicks, timeout diagnostics and isolated snapshot baselines: ok\n')
