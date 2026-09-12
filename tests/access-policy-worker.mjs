import assert from 'node:assert/strict'

const extensionId = 'a'.repeat(32)
const granted = new Set()
const tabs = new Map([
  [1, { id: 1, title: 'Approved', url: 'https://example.org/page', active: true, windowId: 1 }],
  [2, { id: 2, title: 'Other', url: 'https://other.test/page', active: false, windowId: 1 }]
])
const attached = new Set()
let nativeHandler
let popupHandler
const responses = []
let localPolicy
let sessionClaims = []
const port = {
  onMessage: { addListener(fn) { nativeHandler = fn } },
  onDisconnect: { addListener() {} },
  postMessage(message) { responses.push(message) }
}
const noopListener = { addListener() {} }

globalThis.chrome = {
  runtime: {
    id: extensionId,
    getManifest: () => ({ version: '0.8.0' }),
    connectNative: () => port,
    onMessage: { addListener(fn) { popupHandler = fn } },
    onInstalled: noopListener,
    onStartup: noopListener
  },
  storage: {
    local: { get: async () => ({ accessPolicy: localPolicy }), set: async value => { localPolicy = value.accessPolicy } },
    session: { get: async () => ({ claimedTabIds: sessionClaims }), set: async value => { sessionClaims = value.claimedTabIds } }
  },
  permissions: {
    contains: async ({ origins }) => origins.every(pattern => granted.has(pattern) || granted.has(`${pattern.split(':')[0]}://*/*`)),
    onRemoved: noopListener
  },
  tabs: {
    query: async () => [...tabs.values()],
    get: async id => {
      if (!tabs.has(id)) throw new Error('Unknown tab')
      return tabs.get(id)
    },
    create: async ({ url }) => ({ id: 3, url, active: true, windowId: 1 }),
    onRemoved: noopListener,
    onUpdated: noopListener
  },
  debugger: {
    attach: async ({ tabId }) => { attached.add(tabId) },
    detach: async ({ tabId }) => { attached.delete(tabId) },
    sendCommand: async ({ tabId }, method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('tools["guide"]')) {
        return { result: { value: { forms: [], entries: [], scanTruncated: false } } }
      }
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') {
        tabs.get(tabId).url = 'https://other.test/landing'
      }
      return { result: { value: null } }
    },
    onDetach: noopListener
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  },
  alarms: { create() {}, onAlarm: noopListener }
}

await import('../extension/service-worker.js')
await new Promise(resolve => setImmediate(resolve))
const popup = (method, params = {}) => new Promise(resolve => {
  popupHandler({ channel: 'popup', method, params },
    { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }, resolve)
})
async function native(method, params = {}) {
  const requestId = `test-${responses.length}`
  await nativeHandler({ type: 'request', requestId, method, params })
  return responses.find(message => message.requestId === requestId)
}

assert.deepEqual((await native('list')).result, [])
assert.equal((await native('set_access_policy', { policy: { mode: 'all' } })).ok, false)
assert.equal((await native('claim', { tabId: 1 })).ok, false)
granted.add('https://example.org/*')
assert.equal((await popup('set_access_policy', { policy: { mode: 'selected', origins: ['https://example.org'] } })).ok, true)
assert.deepEqual((await native('list')).result.map(tab => tab.id), ['1'])
assert.equal((await native('claim', { tabId: 1 })).ok, true)
assert.equal(attached.has(1), true)
assert.equal((await native('new', { url: 'https://other.test/' })).ok, false)
granted.add('http://*/*')
granted.add('https://*/*')
assert.equal((await popup('set_access_policy', { policy: { mode: 'all' } })).ok, true)
assert.deepEqual((await native('list')).result.map(tab => tab.id), ['1', '2'])
const guide = await native('guide', { tabId: 1 })
assert.equal(guide.ok, true)
assert.equal(guide.result.site.origin, 'https://example.org')
assert.deepEqual(guide.result.map.forms, [])
const advice = await native('advise', { tabId: 1, evidence: { kind: 'navigation', stepCount: 2 } })
assert.equal(advice.ok, true)
assert.equal(advice.result.decision, 'compact_map_only')
assert.deepEqual(advice.result.site, { origin: 'https://example.org', routeHint: '/page' })
const sequence = await native('sequence', { tabId: 1, steps: [
  { action: 'key', key: 'Enter' }, { action: 'wait', ms: 1, continueOnError: true },
  { action: 'wait', ms: 1 }
] })
assert.equal(sequence.ok, true)
assert.equal(sequence.result.siteChanged, true)
assert.equal(sequence.result.steps[1].ok, false)
assert.match(sequence.result.steps[1].error, /site boundary/)
assert.equal(sequence.result.steps.length, 2, 'cross-site boundary must override continueOnError')
tabs.get(1).url = 'https://example.org/page'
assert.equal((await popup('set_access_policy', { policy: { mode: 'selected', origins: [] } })).ok, true)
assert.equal(attached.has(1), false)
assert.deepEqual((await native('list')).result, [])
process.stdout.write('worker access policy and native privilege boundary: ok\n')
