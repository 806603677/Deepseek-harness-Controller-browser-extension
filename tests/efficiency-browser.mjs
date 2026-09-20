import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { headlessBrowser } from './headless-browser.mjs'

const html = `<!doctype html><meta charset="utf-8"><title>Efficiency fixture</title>
<style>#cover{position:fixed;inset:0;background:#ddd;z-index:100} #hidden{visibility:hidden}</style>
<section id="outside"><button>Outside button</button></section>
<section id="panel"><label for="name">Full name</label><input id="name" value="old">
<button id="query" onclick="window.clicks++;document.querySelector('#result').textContent='loading';setTimeout(()=>document.querySelector('#result').textContent='done',150)">Query</button>
<div id="result" role="status">idle</div><input id="agree" type="checkbox"><div id="hidden">hidden</div>
<input id="password" type="password" value="not-for-output"><input id="secret" type="hidden" value="private-token-example">
<div id="shadow"></div><iframe id="frame" srcdoc="<input id='inside' value='frame'><button id='frame-button' onclick='this.textContent=&quot;Clicked&quot;'>Frame button</button>"></iframe></section>
<script>window.clicks=0;document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input id="shadow-field" value="shadow"><button id="shadow-button">Shadow button</button>';</script>`
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) })
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}/`
let browser
let checks = 0
try {
  browser = await headlessBrowser()
  await browser.send('Page.enable')
  await browser.send('Page.navigate', { url })
  const evaluate = async expression => {
    const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`document.readyState==='complete' && !!document.querySelector('#frame')?.contentDocument?.querySelector('#inside')`)) break
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  let handler, popupHandler, enabled = true
  const responses = new Map(), claims = new Set()
  const noop = { addListener() {} }
  const extensionId = 'a'.repeat(32)
  globalThis.chrome = {
    runtime: { id: extensionId, getManifest: () => ({ version: '0.9.0' }),
      connectNative: () => ({ onMessage: { addListener(fn) { handler = fn } }, onDisconnect: noop,
        postMessage(message) { if (message.requestId) responses.set(message.requestId, message) } }),
      onMessage: { addListener(fn) { popupHandler = fn } }, onInstalled: noop, onStartup: noop },
    storage: { local: { get: async () => ({ browserAccessEnabled: enabled }), set: async value => { enabled = value.browserAccessEnabled } },
      session: { get: async () => ({ claimedTabIds: [] }), set: async () => {} } },
    permissions: { contains: async () => true, onRemoved: noop },
    tabs: { get: async id => ({ id, url: await evaluate('location.href'), title: 'Fixture' }), query: async () => [], onRemoved: noop, onUpdated: noop },
    debugger: { attach: async ({ tabId }) => { claims.add(tabId) }, detach: async ({ tabId }) => { claims.delete(tabId) },
      sendCommand: (_target, method, params) => browser.send(method, params), onDetach: noop },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create() {}, onAlarm: noop }
  }
  await import('../extension/service-worker.js')
  await new Promise(resolve => setImmediate(resolve))
  let requestId = 0
  const request = async (method, params = {}) => {
    const id = String(++requestId)
    await handler({ type: 'request', requestId: id, method, params: { tabId: 1, ...params } })
    const response = responses.get(id)
    responses.delete(id)
    return response
  }
  const ok = async (method, params) => {
    const response = await request(method, params)
    assert.equal(response.ok, true, JSON.stringify(response))
    checks++
    return response.result
  }
  const fails = async (method, params, pattern) => {
    const response = await request(method, params)
    assert.equal(response.ok, false, JSON.stringify(response))
    assert.match(response.error, pattern)
    checks++
    return response
  }
  const legacy = await ok('dom')
  assert.ok(legacy.inputs && legacy.buttons && legacy.bodyText)
  const options = { mode: 'compact', scope: 'css=#panel', fields: ['locator', 'text', 'value'], includeValues: true, limit: 100 }
  const compact = await ok('dom', { options })
  assert.equal(compact.elements.some(el => el.text === 'Outside button'), false)
  assert.equal(JSON.stringify(compact).includes('private-token-example'), false)
  assert.equal(JSON.stringify(compact).includes('not-for-output'), false)
  assert.equal('bodyText' in compact, false)
  assert.equal('documentKey' in compact, false)
  const structural = await ok('dom', { options: { mode: 'compact', scope: 'css=#name' } })
  assert.equal('value' in structural.elements[0], false)
  assert.equal(structural.elements[0].text, '')
  await fails('dom', { options: { mode: 'compact', limit: -1 } }, /limit must/)
  assert.ok(compact.elements.some(el => el.locator === 'frame=#frame >>> css=#inside'))
  assert.ok(compact.elements.some(el => el.locator === 'shadow=#shadow >>> css=#shadow-field'))
  assert.ok(JSON.stringify(compact).length < JSON.stringify(legacy).length)
  const fill = await ok('fill', { selectorOrPlaceholder: 'css=#name', value: 'new' })
  assert.equal(fill.domValue, 'new')
  const delta = await ok('dom', { options: { ...options, since: compact.snapshotId } })
  assert.equal(delta.mode, 'diff')
  assert.equal(delta.changed.find(el => el.locator === 'css=#name').value, 'new')
  const small = await ok('dom', { options: { mode: 'compact', scope: 'css=#panel', limit: 1 } })
  assert.equal(small.truncated, true)
  const resetSmall = await ok('dom', { options: { mode: 'compact', scope: 'css=#panel', limit: 1, since: small.snapshotId } })
  assert.equal(resetSmall.resetReason, 'truncated_snapshot')
  await evaluate(`history.pushState({}, '', '/other')`)
  const reset = await ok('dom', { options: { ...options, since: delta.snapshotId } })
  assert.equal(reset.resetReason, 'page_changed')
  const frameOnly = await ok('dom', { options: { mode: 'compact', scope: 'frame=#frame >>> css=body' } })
  assert.ok(frameOnly.elements.every(el => el.locator.startsWith('frame=#frame >>> ')))
  const tableText = await ok('dom', { options: { mode: 'compact', scope: 'css=#result', selector: 'div', includeText: true, textLimit: 2 } })
  assert.equal(tableText.bodyText, 'id')
  assert.equal(tableText.textTruncated, true)
  await ok('waitFor', { target: 'css=#hidden', condition: 'hidden', timeoutMs: 0 })
  await ok('waitFor', { target: 'css=#absent', condition: 'detached', timeoutMs: 0 })
  await ok('assert', { target: 'css=#agree', condition: 'checked', equals: false, timeoutMs: 0 })
  await ok('assert', { target: 'css=#panel > button', condition: 'count', equals: 1, timeoutMs: 0 })
  await fails('assert', { target: 'css=#password', condition: 'value', equals: 'x', timeoutMs: 0 }, /cannot inspect/)
  await fails('waitFor', { target: 'css=button', condition: 'clickable', timeoutMs: 0 }, /Ambiguous/)
  await fails('waitFor', { target: 'frame=#frame >>> css=button, input', condition: 'visible', timeoutMs: 0 }, /Ambiguous locator/)
  await ok('click', { selectorOrText: 'Query' })
  await ok('assert', { target: 'css=#result', condition: 'text', equals: 'done', timeoutMs: 2000 })
  assert.equal(await evaluate('window.clicks'), 1)
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="cover"></div>');setTimeout(()=>document.querySelector('#cover').remove(),200)`)
  await ok('click', { selectorOrText: 'css=#query' })
  assert.equal(await evaluate('window.clicks'), 2)
  await evaluate(`document.querySelector('#query').disabled=true;setTimeout(()=>document.querySelector('#query').disabled=false,150)`)
  await ok('click', { selectorOrText: 'css=#query' })
  await ok('click', { selectorOrText: 'shadow=#shadow >>> css=#shadow-button' })
  await ok('click', { selectorOrText: 'frame=#frame >>> css=#frame-button' })
  assert.equal(await evaluate(`document.querySelector('#frame').contentDocument.querySelector('#frame-button').textContent`), 'Clicked')
  const failed = await ok('sequence', { steps: [
    { action: 'fill', target: 'css=#name', value: 'once', expect: { target: 'css=#name', condition: 'value', equals: 'different', timeoutMs: 0 }, continueOnError: true },
    { action: 'fill', target: 'css=#name', value: 'must-not-run' }
  ] })
  assert.equal(failed.success, false)
  assert.equal(failed.failedIndex, 0)
  assert.equal(failed.steps.length, 1)
  assert.equal(failed.steps[0].phase, 'verification')
  assert.equal(failed.steps[0].details.actual, 'once')
  assert.equal(await evaluate(`document.querySelector('#name').value`), 'once')
  const checked = await ok('sequence', { steps: [
    { action: 'click', target: 'css=#query', expect: { target: 'css=#result', condition: 'text', equals: 'done' } },
    { action: 'assert', target: 'css=#result', condition: 'text', includes: 'don' },
    { action: 'dom', options: { mode: 'compact', scope: 'css=#panel', limit: 20 } }
  ] })
  assert.equal(checked.success, true)
  assert.equal(checked.steps[0].result.verification.matched, true)
  const assertionStop = await ok('sequence', { steps: [
    { action: 'assert', target: 'css=#result', condition: 'text', equals: 'wrong', timeoutMs: 0, continueOnError: true },
    { action: 'fill', target: 'css=#name', value: 'must-not-run' }
  ] })
  assert.equal(assertionStop.steps.length, 1)
  await fails('sequence', { steps: [{ action: 'click', target: 'css=#query' }, { action: 'assert', target: 'css=#result', condition: 'text' }] }, /exactly one/)
  const timeout = await fails('waitFor', { target: 'css=#result', condition: 'text', equals: 'never', timeoutMs: 50 }, /timed out/)
  assert.equal(timeout.code, 'CONDITION_TIMEOUT')
  assert.equal(timeout.details.actual, 'done')
  const oldDocument = await evaluate('performance.timeOrigin')
  await ok('reload')
  assert.notEqual(await evaluate('performance.timeOrigin'), oldDocument)
  assert.equal(await evaluate('window.clicks'), 0, 'reload waits for the new document')
  const afterReload = await ok('dom', { options: { ...options, since: reset.snapshotId } })
  assert.equal(afterReload.resetReason, 'page_changed')
  await ok('navigate', { url: url + 'next' })
  assert.equal(await evaluate('location.pathname'), '/next')
  await ok('navigate', { url: url + 'next#section' })
  assert.equal(await evaluate('location.hash'), '#section')
  // Same fixture origin changes to localhost: an existing pending wait must stop.
  await evaluate(`setTimeout(()=>location.href=${JSON.stringify(url.replace('127.0.0.1', 'localhost'))},100)`)
  await fails('waitFor', { target: 'css=#result', condition: 'text', equals: 'never', timeoutMs: 2000 }, /site boundary/)
  const disabled = await new Promise(resolve => popupHandler({ channel: 'popup', method: 'set_browser_access_enabled', params: { enabled: false } },
    { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }, resolve))
  assert.equal(disabled.ok, true)
  await fails('waitFor', { target: 'css=#result' }, /disabled|not approved/)
  process.stdout.write(`isolated real-browser checks: ${checks} passed; legacy snapshot ${JSON.stringify(legacy).length} chars, scoped snapshot ${JSON.stringify(compact).length} chars\n`)
} finally {
  if (browser) await browser.close()
  server.close()
}
