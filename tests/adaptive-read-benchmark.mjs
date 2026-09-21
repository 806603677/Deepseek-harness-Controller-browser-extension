import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { headlessBrowser } from './headless-browser.mjs'

function page(rowCount) {
  const target = Math.floor(rowCount / 2)
  const rows = Array.from({ length: rowCount }, (_, index) => `<tr id="row-${index}"><td>受试者 ${index}</td>
  <td><label for="field-${index}">检查项 ${index}</label><input id="field-${index}" value="value-${index}"></td>
  <td><button type="button" ${index === target ? `id="query" onclick="window.actions++;document.querySelector('#result').textContent='submitted';setTimeout(()=>{const row=document.createElement('tr');row.id='async-row';row.innerHTML='<td>异步记录</td><td><label for=&quot;async-field&quot;>新增检查项</label><input id=&quot;async-field&quot;></td><td><button type=&quot;button&quot;>Review</button></td>';document.querySelector('#rows').append(row)},80)"` : ''}>Review ${index}</button>
  ${index === target ? '<span id="result" role="status">idle</span>' : ''}</td></tr>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>Adaptive benchmark</title>
<h1>临床数据核查列表</h1><p>只包含虚构数据的性能测试页面。</p><form id="records"><table><thead><tr><th>受试者</th><th>检查项</th><th>操作</th></tr></thead><tbody id="rows">${rows}</tbody></table></form>
<script>window.actions=0</script>`
}

const server = createServer((req, res) => {
  const rowCount = Math.max(5, Math.min(200, Number(new URL(req.url, 'http://localhost').searchParams.get('rows')) || 60))
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page(rowCount))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}/`
const scenarios = [{ name: 'small', rows: 12 }, { name: 'medium', rows: 60 }, { name: 'large', rows: 150 }]
const repetitionsPerModePerScenario = 40
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const percentile = (values, value) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)]
const utf8Bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
// Reproducible proxy only. Actual model/provider usage remains the adoption gate for a live Agent run.
const estimatedTokens = value => {
  const text = JSON.stringify(value)
  let cjk = 0
  for (const character of text) if (/\p{Script=Han}/u.test(character)) cjk++
  return cjk + Math.ceil((text.length - cjk) / 4)
}

let browser
try {
  browser = await headlessBrowser()
  await browser.send('Page.enable')
  await browser.send('Page.navigate', { url })
  const evaluate = async expression => {
    const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  for (let attempt = 0; attempt < 100 && !await evaluate(`document.readyState==='complete' && !!document.querySelector('input')`); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  let handler, enabled = true
  const responses = new Map()
  const noop = { addListener() {} }
  const extensionId = 'b'.repeat(32)
  globalThis.chrome = {
    runtime: { id: extensionId, getManifest: () => ({ version: '0.9.0-experiment' }),
      connectNative: () => ({ onMessage: { addListener(fn) { handler = fn } }, onDisconnect: noop,
        postMessage(message) { if (message.requestId) responses.set(message.requestId, message) } }),
      onMessage: noop, onInstalled: noop, onStartup: noop },
    storage: { local: { get: async () => ({ browserAccessEnabled: enabled }), set: async value => { enabled = value.browserAccessEnabled } },
      session: { get: async () => ({ claimedTabIds: [] }), set: async () => {} } },
    permissions: { contains: async () => true, onRemoved: noop },
    tabs: { get: async id => ({ id, url: await evaluate('location.href'), title: 'Benchmark' }), query: async () => [], onRemoved: noop, onUpdated: noop },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: (_target, method, params) => browser.send(method, params), onDetach: noop },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create() {}, onAlarm: noop }
  }
  await import('../extension/service-worker.js')
  await new Promise(resolve => setImmediate(resolve))
  let requestId = 0
  const request = async (method, params = {}) => {
    const id = String(++requestId)
    const started = performance.now()
    await handler({ type: 'request', requestId: id, method, params: { tabId: 1, ...params } })
    const elapsedMs = performance.now() - started
    const response = responses.get(id)
    responses.delete(id)
    assert.equal(response?.ok, true, JSON.stringify(response))
    return { result: response.result, elapsedMs }
  }

  const runWorkflow = async (mode, scenario) => {
    const target = Math.floor(scenario.rows / 2)
    await request('navigate', { url: `${url}?rows=${scenario.rows}` })
    const started = performance.now()
    const outputs = []
    const readTimes = []
    const read = async () => {
      const response = await request('dom', mode === 'full' ? { options: { mode: 'full' } } : {})
      outputs.push(response.result)
      readTimes.push(response.elapsedMs)
      return response.result
    }
    const first = await read()
    const fill = await request('fill', { selectorOrPlaceholder: `css=#field-${target}`, value: 'updated' })
    outputs.push(fill.result)
    const second = await read()
    const click = await request('click', { selectorOrText: 'css=#query' })
    outputs.push(click.result)
    const submitted = await request('waitFor', { target: 'css=#result', condition: 'text', equals: 'submitted', timeoutMs: 2000 })
    outputs.push(submitted.result)
    const third = await read()
    const added = await request('waitFor', { target: 'css=#async-row', condition: 'visible', timeoutMs: 2000 })
    outputs.push(added.result)
    const fourth = await read()
    const correct = await evaluate(`document.querySelector('#field-${target}').value==='updated' && window.actions===1 && !!document.querySelector('#async-row')`)
    const modes = [first, second, third, fourth].map(item => item.read?.mode || 'legacy')
    const readFallbacks = [first, second, third, fourth].filter(item => item.read?.fallbackFrom).length
    return { mode, scenario: scenario.name, rows: scenario.rows, correct, workflowMs: performance.now() - started, readMs: readTimes.reduce((sum, item) => sum + item, 0),
      bytes: outputs.reduce((sum, item) => sum + utf8Bytes(item), 0),
      estimatedTokens: outputs.reduce((sum, item) => sum + estimatedTokens(item), 0), toolCalls: outputs.length,
      readCalls: readTimes.length, readFallbacks, readModes: modes }
  }

  for (const scenario of scenarios) {
    await runWorkflow('full', scenario)
    await runWorkflow('auto', scenario)
  }
  const runs = []
  for (const scenario of scenarios) {
    for (let iteration = 0; iteration < repetitionsPerModePerScenario; iteration++) {
      for (const mode of iteration % 2 ? ['auto', 'full'] : ['full', 'auto']) runs.push(await runWorkflow(mode, scenario))
    }
  }
  const summarize = selected => ({ runs: selected.length, correctRuns: selected.filter(run => run.correct).length,
    workflowMedianMs: Math.round(median(selected.map(run => run.workflowMs)) * 10) / 10,
    workflowP95Ms: Math.round(percentile(selected.map(run => run.workflowMs), 0.95) * 10) / 10,
    readMedianMs: Math.round(median(selected.map(run => run.readMs)) * 10) / 10,
    readP95Ms: Math.round(percentile(selected.map(run => run.readMs), 0.95) * 10) / 10,
    medianBytes: median(selected.map(run => run.bytes)), medianEstimatedTokens: median(selected.map(run => run.estimatedTokens)),
    minToolCalls: Math.min(...selected.map(run => run.toolCalls)), maxToolCalls: Math.max(...selected.map(run => run.toolCalls)),
    readCalls: selected.reduce((sum, run) => sum + run.readCalls, 0),
    supplementalReads: selected.reduce((sum, run) => sum + run.readFallbacks, 0),
    supplementalReadRatePercent: Math.round(selected.reduce((sum, run) => sum + run.readFallbacks, 0)
      / selected.reduce((sum, run) => sum + run.readCalls, 0) * 1000) / 10,
    exampleReadModes: selected[0].readModes })
  const summary = Object.fromEntries(['full', 'auto'].map(mode => {
    const selected = runs.filter(run => run.mode === mode)
    return [mode, summarize(selected)]
  }))
  const scenarioSummary = Object.fromEntries(scenarios.map(scenario => [scenario.name,
    Object.fromEntries(['full', 'auto'].map(mode => {
      const selected = runs.filter(run => run.mode === mode && run.scenario === scenario.name)
      return [mode, summarize(selected)]
    }))]))
  const reduction = (before, after) => Math.round((1 - after / before) * 1000) / 10
  const compare = pair => ({
    workflowTimeImprovementPercent: reduction(pair.full.workflowMedianMs, pair.auto.workflowMedianMs),
    workflowP95ImprovementPercent: reduction(pair.full.workflowP95Ms, pair.auto.workflowP95Ms),
    readTimeImprovementPercent: reduction(pair.full.readMedianMs, pair.auto.readMedianMs),
    payloadReductionPercent: reduction(pair.full.medianBytes, pair.auto.medianBytes),
    estimatedTokenReductionPercent: reduction(pair.full.medianEstimatedTokens, pair.auto.medianEstimatedTokens)
  })
  const comparison = { ...compare(summary), exactProviderTokensAvailable: false }
  const scenarioComparison = Object.fromEntries(Object.entries(scenarioSummary).map(([name, pair]) => [name, compare(pair)]))
  const correctnessPassed = summary.full.correctRuns === summary.full.runs && summary.auto.correctRuns === summary.auto.runs
  const perScenarioSpeedPassed = Object.values(scenarioComparison).every(item => item.workflowTimeImprovementPercent >= -5)
  const speedPassed = perScenarioSpeedPassed && comparison.workflowTimeImprovementPercent >= -5
  const perScenarioTailLatencyPassed = Object.values(scenarioComparison).every(item => item.workflowP95ImprovementPercent >= -20)
  const tailLatencyPassed = perScenarioTailLatencyPassed && comparison.workflowP95ImprovementPercent >= -10
  const tokenProxyPassed = comparison.estimatedTokenReductionPercent >= 25
  const toolCallsPassed = summary.auto.maxToolCalls <= summary.full.maxToolCalls
  const supplementalReadsPassed = summary.auto.supplementalReadRatePercent <= 15
  const decision = correctnessPassed && speedPassed && tailLatencyPassed && tokenProxyPassed && toolCallsPassed && supplementalReadsPassed
    ? 'provisional_pass_requires_live_provider_usage'
    : comparison.estimatedTokenReductionPercent >= 15 && comparison.workflowTimeImprovementPercent >= -5 ? 'keep_optional'
      : 'reject_and_retain_baseline'
  const report = { generatedAt: new Date().toISOString(), baselineCommit: 'd43bf1d9010c912ece947e9121e7af5fbfbdb135',
    scope: 'isolated Chromium controller workflows; no model inference or real EDC', repetitionsPerModePerScenario,
    scenarios, tokenMetric: 'reproducible estimate: Han characters + remaining characters / 4', summary, scenarioSummary,
    comparison, scenarioComparison,
    acceptance: { correctnessPassed, speedPassed, perScenarioSpeedPassed, tailLatencyPassed, perScenarioTailLatencyPassed,
      tokenProxyPassed, toolCallsPassed, supplementalReadsPassed, decision,
      note: 'Do not make auto mode the published default until a same-model live run provides actual usage tokens.' }, runs }
  const output = process.env.DSH_BENCHMARK_OUTPUT
  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true })
    await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n', 'utf8')
  }
  process.stdout.write(JSON.stringify({ ...report, runs: undefined }, null, 2) + '\n')
} finally {
  if (browser) await browser.close()
  server.close()
}
