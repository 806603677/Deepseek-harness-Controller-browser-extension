import { DEFAULT_ACCESS_POLICY, isAllowedUrl, normalizeAccessPolicy, permissionPatterns } from './allowed-origins.js'
import { createPageTools } from './page-tools.js'
import { assessWorkflow } from './workflow-advice.js'

const NATIVE_HOST = 'com.dsh.edge'
const RECONNECT_ALARM = 'dsh-native-host-reconnect'
let nativePort = null
let reconnectTimer = null
const claimedTabs = new Set()
let accessPolicy = DEFAULT_ACCESS_POLICY
const policyReady = chrome.storage.local.get('accessPolicy').then(stored => {
  try { accessPolicy = normalizeAccessPolicy(stored.accessPolicy) } catch { /* fail closed */ }
}).catch(() => {})

async function siteIsAllowed(rawUrl) {
  if (!isAllowedUrl(rawUrl, accessPolicy)) return false
  return chrome.permissions.contains({ origins: [`${new URL(rawUrl).origin}/*`] })
}

function sanitizedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    url.username = ''
    url.password = ''
    for (const key of ['t', 'token', 'access_token', 'session', 'sid']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '<redacted>')
    }
    return url.toString()
  } catch {
    return ''
  }
}

function routeHint(rawUrl) {
  try {
    return new URL(rawUrl).pathname.split('/').map(segment =>
      /^\d{3,}$|^[0-9a-f]{8}-[0-9a-f-]{20,}$|^[0-9a-f]{16,}$/i.test(segment) ? ':id' : segment).join('/')
  } catch { return '' }
}

function scheduleReconnect(delayMs = 2000) {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectNativeHost()
  }, delayMs)
}

function connectNativeHost() {
  if (nativePort) return
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST)
    nativePort = port
    port.onMessage.addListener(handleNativeRequest)
    port.onDisconnect.addListener(() => {
      if (nativePort === port) nativePort = null
      scheduleReconnect()
    })
    port.postMessage({
      type: 'event',
      event: 'extension_ready',
      version: chrome.runtime.getManifest().version
    })
  } catch {
    nativePort = null
    scheduleReconnect()
  }
}

async function storedClaimIds() {
  const stored = await chrome.storage.session.get('claimedTabIds')
  return Array.isArray(stored.claimedTabIds) ? stored.claimedTabIds : []
}

async function saveClaims() {
  await chrome.storage.session.set({ claimedTabIds: [...claimedTabs] })
}

async function tabSummary(tab) {
  return {
    id: String(tab.id),
    title: tab.title || '',
    url: sanitizedUrl(tab.url || ''),
    active: Boolean(tab.active),
    windowId: tab.windowId,
    claimed: claimedTabs.has(tab.id)
  }
}

async function listAllowedTabs() {
  const tabs = await chrome.tabs.query({})
  const allowed = []
  for (const tab of tabs) if (tab.id && await siteIsAllowed(tab.url || '')) allowed.push(tab)
  return Promise.all(allowed.map(tabSummary))
}

async function claimTab(tabId) {
  const numericId = Number(tabId)
  const tab = await chrome.tabs.get(numericId)
  if (!await siteIsAllowed(tab.url || '')) {
    throw new Error('Site not approved in the extension popup or browser permissions')
  }
  if (claimedTabs.has(numericId)) return tabSummary(tab)

  await chrome.debugger.attach({ tabId: numericId }, '1.3')
  claimedTabs.add(numericId)
  await saveClaims()
  await chrome.action.setBadgeText({ tabId: numericId, text: 'DSH' })
  await chrome.action.setBadgeBackgroundColor({ tabId: numericId, color: '#1769aa' })
  return tabSummary(tab)
}

async function releaseTab(tabId) {
  const numericId = Number(tabId)
  if (claimedTabs.has(numericId)) {
    try {
      await chrome.debugger.detach({ tabId: numericId })
    } catch {
      // The browser may already have detached a closed or replaced target.
    }
  }
  claimedTabs.delete(numericId)
  await saveClaims()
  try { await chrome.action.setBadgeText({ tabId: numericId, text: '' }) } catch {}
  return { released: true, tabId: String(numericId) }
}

async function releaseAllTabs() {
  const ids = [...claimedTabs]
  for (const tabId of ids) await releaseTab(tabId)
  return { released: ids.map(String) }
}

async function requireClaimed(tabId) {
  const numericId = Number(tabId)
  if (!claimedTabs.has(numericId)) throw new Error(`Tab ${tabId} is not claimed by DSH`)
  const tab = await chrome.tabs.get(numericId)
  if (!await siteIsAllowed(tab.url || '')) {
    await releaseTab(numericId)
    throw new Error('Claimed tab left the user-approved site scope')
  }
  return numericId
}

async function ensureClaimed(tabId) {
  const numericId = Number(tabId)
  if (claimedTabs.has(numericId)) return requireClaimed(numericId)
  await claimTab(numericId)
  return numericId
}

async function cdp(tabId, method, params = {}) {
  const numericId = await requireClaimed(tabId)
  return chrome.debugger.sendCommand({ tabId: numericId }, method, params)
}

async function evaluate(tabId, expression, awaitPromise = true) {
  if (/document\.cookie|localStorage|sessionStorage|indexedDB/i.test(expression)) {
    throw new Error('Reading browser credentials or storage is blocked by the DSH bridge')
  }
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise
  })
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'JavaScript evaluation failed'
    throw new Error(text)
  }
  return result.result?.value ?? result.result
}

async function waitForReady(tabId, timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await evaluate(tabId, 'document.readyState', false)
      if (state === 'complete') {
        await new Promise(resolve => setTimeout(resolve, 1200))
        return
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('Timed out waiting for the page to finish loading')
}

async function pageAction(tabId, action, ...args) {
  const supported = new Set(['search', 'state', 'fill', 'blur', 'point', 'snapshot', 'guide'])
  if (!supported.has(action)) throw new Error(`Unsupported page action: ${action}`)
  return evaluate(tabId, `(() => {
    const tools = (${createPageTools.toString()})();
    return tools[${JSON.stringify(action)}](...${JSON.stringify(args)});
  })()`)
}

async function domSnapshot(tabId) {
  const result = await pageAction(tabId, 'snapshot')
  const tab = await chrome.tabs.get(Number(tabId))
  return { ...result, url: sanitizedUrl(tab.url || '') }
}

async function findElements(tabId, query, limit = 100) {
  return pageAction(tabId, 'search', query, limit)
}

async function pageGuide(tabId) {
  const before = await chrome.tabs.get(Number(tabId))
  const map = await pageAction(tabId, 'guide')
  const tab = await chrome.tabs.get(Number(tabId))
  if (new URL(before.url).origin !== new URL(tab.url).origin || new URL(before.url).pathname !== new URL(tab.url).pathname) {
    throw new Error('Page changed while building the guide; retry on the current page')
  }
  return {
    site: { origin: new URL(tab.url).origin, routeHint: routeHint(tab.url) },
    map,
    reminder: 'Check only this site’s Memory before drafting a workflow. The bridge does not write Memory or Skills; ask the user before creating a site Skill.'
  }
}

async function locateElement(tabId, selectorOrText) {
  return pageAction(tabId, 'point', selectorOrText)
}

async function clickElement(tabId, selectorOrText) {
  const point = await locateElement(tabId, selectorOrText)
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return point
}

async function fillElement(tabId, target, value) {
  return pageAction(tabId, 'fill', target, value)
}

async function elementState(tabId, target) {
  return pageAction(tabId, 'state', target)
}

async function blurElement(tabId, target) {
  return pageAction(tabId, 'blur', target)
}

async function sendKey(tabId, step) {
  const key = String(step.key || '')
  const code = String(step.code || key)
  const vk = Number(step.windowsVirtualKeyCode || 0)
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  return { sent: key }
}

async function runSequence(tabId, steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('sequence requires a non-empty steps array')
  if (steps.length > 50) throw new Error('sequence is limited to 50 steps')
  const started = performance.now()
  const results = []
  const startingOrigin = new URL((await chrome.tabs.get(Number(tabId))).url).origin

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] || {}
    const action = String(step.action || '')
    try {
      const currentOrigin = new URL((await chrome.tabs.get(Number(tabId))).url).origin
      if (currentOrigin !== startingOrigin) throw new Error('Sequence crossed a site boundary; stop, reload current-site Memory, and start a new sequence')
      let result
      switch (action) {
        case 'click':
          result = await clickElement(tabId, String(step.target || ''))
          break
        case 'fill':
          result = await fillElement(tabId, String(step.target || ''), step.value ?? '')
          break
        case 'key':
          result = await sendKey(tabId, step)
          break
        case 'wait': {
          const delayMs = Math.max(0, Math.min(Number(step.ms || 0), 10000))
          await new Promise(resolve => setTimeout(resolve, delayMs))
          result = { waitedMs: delayMs }
          break
        }
        case 'value':
          result = await elementState(tabId, String(step.target || ''))
          break
        case 'find':
          result = await findElements(tabId, String(step.query || ''), step.limit ?? 100)
          break
        case 'blur':
          result = await blurElement(tabId, String(step.target || ''))
          break
        case 'reload':
          await cdp(tabId, 'Page.reload', { ignoreCache: Boolean(step.ignoreCache) })
          await waitForReady(tabId, Math.min(Number(step.timeoutMs || 60000), 120000))
          result = tabSummary(await chrome.tabs.get(Number(tabId)))
          break
        case 'eval':
          result = await evaluate(tabId, String(step.expression || ''), step.awaitPromise !== false)
          break
        case 'text':
          result = await evaluate(tabId, `(document.body?.innerText || '').slice(0, ${Math.min(Number(step.limit || 5000), 30000)})`)
          break
        default:
          throw new Error(`Unsupported sequence action: ${action}`)
      }
      results.push({ index, action, ok: true, result })
    } catch (error) {
      results.push({ index, action, ok: false, error: error?.message || String(error) })
      const currentOrigin = new URL((await chrome.tabs.get(Number(tabId))).url).origin
      if (currentOrigin !== startingOrigin || step.continueOnError !== true) break
    }
  }

  const endingOrigin = new URL((await chrome.tabs.get(Number(tabId))).url).origin
  return { elapsedMs: Math.round(performance.now() - started), steps: results,
    siteChanged: endingOrigin !== startingOrigin,
    reminder: endingOrigin !== startingOrigin ? 'Stop here; load the destination site context before another action.' : undefined }
}

async function executeRequest(message, source = 'native') {
  await policyReady
  const params = message.params || {}
  const tabScopedMethods = new Set(['navigate', 'reload', 'dom', 'find', 'guide', 'advise', 'text', 'eval', 'screenshot', 'click', 'fill', 'blur', 'key', 'value', 'sequence'])
  if (tabScopedMethods.has(message.method)) await ensureClaimed(params.tabId)
  switch (message.method) {
    case 'status':
      return { nativeHostConnected: Boolean(nativePort), claimedTabIds: [...claimedTabs].map(String), accessPolicy }
    case 'set_access_policy': {
      if (source !== 'popup') throw new Error('Only the browser popup can change site access')
      const next = normalizeAccessPolicy(params.policy)
      for (const pattern of permissionPatterns(next)) {
        if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error(`Browser permission missing: ${pattern}`)
      }
      await chrome.storage.local.set({ accessPolicy: next })
      accessPolicy = next
      for (const tabId of [...claimedTabs]) {
        try { await requireClaimed(tabId) } catch { /* revoked or out of scope */ }
      }
      return accessPolicy
    }
    case 'list':
      return listAllowedTabs()
    case 'claim':
      return claimTab(params.tabId)
    case 'release':
      return releaseTab(params.tabId)
    case 'release_all':
      return releaseAllTabs()
    case 'new': {
      if (!await siteIsAllowed(params.url)) throw new Error('URL is outside user-approved sites')
      const tab = await chrome.tabs.create({ url: params.url, active: true })
      return tabSummary(tab)
    }
    case 'navigate': {
      const tabId = Number(params.tabId)
      if (!await siteIsAllowed(params.url)) throw new Error('URL is outside user-approved sites')
      await cdp(tabId, 'Page.navigate', { url: params.url })
      await waitForReady(tabId)
      return tabSummary(await chrome.tabs.get(tabId))
    }
    case 'reload': {
      const tabId = Number(params.tabId)
      await cdp(tabId, 'Page.reload', { ignoreCache: Boolean(params.ignoreCache) })
      await waitForReady(tabId, Math.min(Number(params.timeoutMs || 60000), 120000))
      return tabSummary(await chrome.tabs.get(tabId))
    }
    case 'dom':
      return domSnapshot(params.tabId)
    case 'find':
      return findElements(params.tabId, String(params.query || ''), params.limit ?? 100)
    case 'guide':
      return pageGuide(params.tabId)
    case 'advise': {
      const tab = await chrome.tabs.get(Number(params.tabId))
      return { site: { origin: new URL(tab.url).origin, routeHint: routeHint(tab.url) },
        ...assessWorkflow(params.evidence) }
    }
    case 'text':
      return evaluate(params.tabId, `(document.body?.innerText || '').slice(0, 30000)`)
    case 'eval':
      return evaluate(params.tabId, String(params.expression || ''), params.awaitPromise !== false)
    case 'screenshot':
      return cdp(params.tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true })
    case 'click':
      return clickElement(params.tabId, String(params.selectorOrText || ''))
    case 'fill':
      return fillElement(params.tabId, String(params.selectorOrPlaceholder || ''), params.value ?? '')
    case 'blur':
      return blurElement(params.tabId, String(params.selectorOrPlaceholder || ''))
    case 'key':
      return sendKey(params.tabId, params)
    case 'value':
      return elementState(params.tabId, String(params.selectorOrPlaceholder || ''))
    case 'sequence':
      return runSequence(params.tabId, params.steps)
    default:
      throw new Error(`Unsupported DSH Edge method: ${message.method}`)
  }
}

async function handleNativeRequest(message) {
  if (!message || message.type !== 'request' || !message.requestId) return
  try {
    const result = await executeRequest(message)
    nativePort?.postMessage({ type: 'response', requestId: message.requestId, ok: true, result })
  } catch (error) {
    nativePort?.postMessage({ type: 'response', requestId: message.requestId, ok: false, error: error?.message || String(error) })
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== 'popup') return false
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/popup.html`)) return false
  executeRequest({ method: message.method, params: message.params || {} }, 'popup')
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }))
  return true
})

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId == null) return
  claimedTabs.delete(source.tabId)
  saveClaims().catch(() => {})
  chrome.action.setBadgeText({ tabId: source.tabId, text: '' }).catch(() => {})
})

chrome.tabs.onRemoved.addListener(tabId => {
  if (!claimedTabs.delete(tabId)) return
  saveClaims().catch(() => {})
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!claimedTabs.has(tabId) || !changeInfo.url) return
  policyReady.then(() => siteIsAllowed(changeInfo.url)).then(allowed => {
    if (!allowed) return releaseTab(tabId)
  }).catch(() => releaseTab(tabId).catch(() => {}))
})

chrome.permissions.onRemoved.addListener(() => {
  policyReady.then(async () => {
    for (const tabId of [...claimedTabs]) {
      try { await requireClaimed(tabId) } catch { /* permission revoked */ }
    }
  }).catch(() => {})
})

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM && !nativePort) connectNativeHost()
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
  connectNativeHost()
})

chrome.runtime.onStartup.addListener(connectNativeHost)

async function restoreStoredClaims() {
  await policyReady
  for (const tabId of await storedClaimIds()) {
    try {
      const tab = await chrome.tabs.get(Number(tabId))
      if (!await siteIsAllowed(tab.url || '')) continue
      await chrome.debugger.attach({ tabId: Number(tabId) }, '1.3')
      claimedTabs.add(Number(tabId))
      await chrome.action.setBadgeText({ tabId: Number(tabId), text: 'DSH' })
      await chrome.action.setBadgeBackgroundColor({ tabId: Number(tabId), color: '#1769aa' })
    } catch {
      // A prior debugger may still own the tab. The popup can release/reclaim it.
    }
  }
  await saveClaims()
}

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
restoreStoredClaims().finally(connectNativeHost)
