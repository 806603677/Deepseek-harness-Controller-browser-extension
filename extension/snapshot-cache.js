// Ephemeral, bounded baselines. Never persist page content to browser storage or disk.
export class SnapshotCache {
  constructor({ maxEntries = 20, ttlMs = 300000, now = () => Date.now(), id = () => crypto.randomUUID() } = {}) {
    this.entries = new Map()
    Object.assign(this, { maxEntries, ttlMs, now, id })
  }

  clearTab(tabId) {
    for (const [id, entry] of this.entries) if (entry.tabId === String(tabId)) this.entries.delete(id)
  }

  capture(tabId, raw, options = {}, { maxChangeRatio = Number.POSITIVE_INFINITY } = {}) {
    const time = this.now()
    for (const [id, entry] of this.entries) if (time - entry.time >= this.ttlMs) this.entries.delete(id)
    const { documentKey, baselineElements, ...snapshot } = raw
    const comparisonElements = baselineElements || snapshot.elements
    const { since, ...shape } = options
    const signature = JSON.stringify(Object.keys(shape).sort().map(key => [key, shape[key]]))
    const previous = since ? this.entries.get(since) : null
    let resetReason = null
    if (since) {
      if (!previous || previous.tabId !== String(tabId)) resetReason = 'baseline_missing'
      else if (previous.documentKey !== documentKey) resetReason = 'page_changed'
      else if (previous.signature !== signature) resetReason = 'options_changed'
      else if (snapshot.baselineTruncated || previous.snapshot.baselineTruncated) resetReason = 'truncated_snapshot'
    }
    const snapshotId = this.id()
    const storedSnapshot = { ...snapshot, elements: comparisonElements }
    this.entries.set(snapshotId, { tabId: String(tabId), documentKey, signature, snapshot: storedSnapshot, time })
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value)
    if (!since || resetReason) return { ...snapshot, snapshotId, ...(since ? { reset: true, resetReason } : {}) }
    const oldElements = new Map(previous.snapshot.elements.map(el => [el.locator, el]))
    const newElements = new Map(comparisonElements.map(el => [el.locator, el]))
    const added = [], changed = [], removed = []
    for (const [locator, el] of newElements) {
      if (!oldElements.has(locator)) added.push(el)
      else if (JSON.stringify(oldElements.get(locator)) !== JSON.stringify(el)) changed.push(el)
    }
    for (const locator of oldElements.keys()) if (!newElements.has(locator)) removed.push(locator)
    const changeCount = added.length + changed.length + removed.length
    const changeRatio = changeCount / Math.max(1, oldElements.size)
    if (changeRatio > maxChangeRatio) return { ...snapshot, snapshotId, reset: true, resetReason: 'change_ratio', changeRatio }
    const changeLimit = Math.max(1, Math.min(Number(options.limit) || 100, 500))
    return { mode: 'diff', snapshotId, since, reset: false, title: snapshot.title, ready: snapshot.ready,
      scope: snapshot.scope, elementsCount: snapshot.elementsCount, returnedCount: snapshot.returnedCount,
      truncated: snapshot.truncated, baselineTruncated: snapshot.baselineTruncated,
      scanTruncated: snapshot.scanTruncated, changeRatio, changeCount,
      added: added.slice(0, changeLimit), changed: changed.slice(0, changeLimit), removed: removed.slice(0, changeLimit),
      changesTruncated: changeCount > changeLimit,
      ...(snapshot.bodyText !== previous.snapshot.bodyText ? { bodyText: snapshot.bodyText } : {}),
      ...(snapshot.textTruncated !== undefined ? { textTruncated: snapshot.textTruncated } : {}) }
  }
}
