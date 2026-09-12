#!/usr/bin/env node
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PIPE = process.env.DSH_EDGE_PIPE || '\\\\.\\pipe\\dsh-edge-bridge-v1'
const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_EDGE_TIMEOUT_MS || 120000)
const TRANSPORT = String(process.env.DSH_EDGE_TRANSPORT || 'auto').toLowerCase()
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..', 'runtime')
const TRANSPORT_PREFERENCE_PATH = path.join(RUNTIME_DIRECTORY, 'transport-preference.json')
let lastTransport = 'unknown'

const USAGE = `usage:
  node dsh-edge.mjs status
  node dsh-edge.mjs list
  node dsh-edge.mjs claim <tabId>
  node dsh-edge.mjs release <tabId>
  node dsh-edge.mjs release-all
  node dsh-edge.mjs new <approvedUrl>
  node dsh-edge.mjs nav <approvedUrl> [tabId]
  node dsh-edge.mjs dom [tabId]
  node dsh-edge.mjs find <text|label=...|placeholder=...|role=...|css=...> [tabId]
  node dsh-edge.mjs guide [tabId]
  node dsh-edge.mjs advise <evidence.json> [tabId]
  node dsh-edge.mjs text [tabId]
  node dsh-edge.mjs click <selectorOrText> [tabId]
  node dsh-edge.mjs fill <selectorOrPlaceholder> <value> [tabId]
  node dsh-edge.mjs value <selectorOrPlaceholder> [tabId]
  node dsh-edge.mjs blur <selectorOrPlaceholder> [tabId]
  node dsh-edge.mjs fill-enter <selectorOrPlaceholder> <value> [tabId]
  node dsh-edge.mjs key <key> <code> <windowsVirtualKeyCode> [tabId]
  node dsh-edge.mjs reload [tabId]
  node dsh-edge.mjs shot <out.png> [tabId]
  node dsh-edge.mjs eval <javascript> [tabId]
  node dsh-edge.mjs eval-file <script.js> [tabId]
  node dsh-edge.mjs sequence <steps.json> [tabId]
  node dsh-edge.mjs sequence-json <jsonArray> [tabId]`

function pipeRequest(requestId, method, params, timeoutMs) {
  const payload = JSON.stringify({ type: 'request', requestId, method, params }) + '\n'

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE)
    let buffer = ''
    let settled = false

    const finish = (error, response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(response)
    }

    const timer = setTimeout(() => finish(new Error(`DSH Edge request timed out after ${timeoutMs}ms`)), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(payload))
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let response
      try { response = JSON.parse(buffer.slice(0, newline)) }
      catch (error) { return finish(new Error(`Invalid Native Host response: ${error.message}`)) }
      if (response.requestId && response.requestId !== requestId) return finish(new Error('Native Host response ID mismatch'))
      if (!response.ok) return finish(new Error(response.error || 'DSH Edge request failed'))
      finish(null, response.result)
    })
    socket.on('error', error => {
      const wrapped = new Error(error.code === 'ENOENT'
        ? 'DSH Native Host is unavailable. Install it and reload the browser extension.'
        : error.message)
      wrapped.code = error.code
      finish(wrapped)
    })
    socket.on('end', () => {
      if (!settled) finish(new Error('DSH Edge Native Host closed the connection without a response'))
    })
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fileRequest(requestId, method, params, timeoutMs) {
  const requestsDirectory = path.join(RUNTIME_DIRECTORY, 'requests')
  const responsesDirectory = path.join(RUNTIME_DIRECTORY, 'responses')
  await mkdir(requestsDirectory, { recursive: true })
  await mkdir(responsesDirectory, { recursive: true })

  const requestPath = path.join(requestsDirectory, `${requestId}.json`)
  const temporaryPath = `${requestPath}.${process.pid}.tmp`
  const responsePath = path.join(responsesDirectory, `${requestId}.json`)
  const payload = JSON.stringify({ type: 'request', requestId, method, params })
  await writeFile(temporaryPath, payload, 'utf8')
  await rename(temporaryPath, requestPath)

  const started = Date.now()
  try {
    while (Date.now() - started < timeoutMs) {
      try {
        const response = JSON.parse(await readFile(responsePath, 'utf8'))
        await unlink(responsePath).catch(() => {})
        if (response.requestId && response.requestId !== requestId) throw new Error('Native Host response ID mismatch')
        if (!response.ok) throw new Error(response.error || 'DSH Edge request failed')
        return response.result
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await sleep(25)
    }

    let heartbeat = 'unknown'
    try {
      const info = await stat(path.join(RUNTIME_DIRECTORY, 'host-alive.json'))
      heartbeat = `${Math.round((Date.now() - info.mtimeMs) / 1000)}s old`
    } catch {}
    throw new Error(`DSH Edge file bridge timed out after ${timeoutMs}ms; host heartbeat: ${heartbeat}`)
  } finally {
    await unlink(requestPath).catch(() => {})
    await unlink(temporaryPath).catch(() => {})
  }
}

async function request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const requestId = randomUUID()
  if (TRANSPORT === 'pipe') {
    const result = await pipeRequest(requestId, method, params, timeoutMs)
    lastTransport = 'pipe'
    return result
  }
  if (TRANSPORT === 'file') {
    const result = await fileRequest(requestId, method, params, timeoutMs)
    lastTransport = 'file'
    return result
  }
  if (TRANSPORT !== 'auto') throw new Error(`Unsupported DSH_EDGE_TRANSPORT: ${TRANSPORT}`)

  try {
    const preference = JSON.parse(await readFile(TRANSPORT_PREFERENCE_PATH, 'utf8'))
    if (preference.transport === 'file' && Number(preference.until || 0) > Date.now()) {
      const result = await fileRequest(requestId, method, params, timeoutMs)
      lastTransport = 'file'
      return result
    }
  } catch {}

  try {
    const result = await pipeRequest(requestId, method, params, timeoutMs)
    lastTransport = 'pipe'
    return result
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error
    await mkdir(RUNTIME_DIRECTORY, { recursive: true })
    await writeFile(TRANSPORT_PREFERENCE_PATH, JSON.stringify({ transport: 'file', until: Date.now() + 5 * 60 * 1000 }), 'utf8').catch(() => {})
    const result = await fileRequest(requestId, method, params, timeoutMs)
    lastTransport = 'file'
    return result
  }
}

async function resolveTabId(preferred, requireClaimed = true) {
  if (preferred) {
    if (!/^\d+$/.test(String(preferred))) throw new Error(`Invalid tabId: ${preferred}`)
    return String(preferred)
  }
  const tabs = await request('list')
  const candidates = requireClaimed ? tabs.filter(tab => tab.claimed) : tabs
  if (candidates.length === 1) return candidates[0].id
  if (!candidates.length) throw new Error(requireClaimed ? 'No approved tab is claimed. Run list, then claim <tabId>.' : 'No approved tab is open.')
  throw new Error(`Multiple ${requireClaimed ? 'claimed ' : ''}tabs exist; pass an exact tabId.`)
}

function print(value) {
  if (typeof value === 'string') process.stdout.write(value + '\n')
  else process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function main() {
  const [, , command, ...args] = process.argv
  if (!command) throw new Error(USAGE)

  switch (command) {
    case 'status': {
      const result = await request('status')
      return print({ ...result, clientTransport: lastTransport })
    }
    case 'list': return print(await request('list'))
    case 'claim':
      if (!args[0]) throw new Error('claim requires tabId')
      return print(await request('claim', { tabId: args[0] }))
    case 'release':
      if (!args[0]) throw new Error('release requires tabId')
      return print(await request('release', { tabId: args[0] }))
    case 'release-all': return print(await request('release_all'))
    case 'new':
      if (!args[0]) throw new Error('new requires an approved URL')
      return print(await request('new', { url: args[0] }))
    case 'nav': {
      if (!args[0]) throw new Error('nav requires an approved URL')
      const tabId = await resolveTabId(args[1])
      return print(await request('navigate', { url: args[0], tabId }))
    }
    case 'dom': {
      const tabId = await resolveTabId(args[0])
      return print(await request('dom', { tabId }))
    }
    case 'find': {
      if (!args[0]) throw new Error('find requires a search query')
      const tabId = await resolveTabId(args[1])
      return print(await request('find', { query: args[0], tabId }))
    }
    case 'guide': {
      const tabId = await resolveTabId(args[0])
      return print(await request('guide', { tabId }))
    }
    case 'advise': {
      if (!args[0]) throw new Error('advise requires an evidence JSON file')
      const evidence = JSON.parse(await readFile(args[0], 'utf8'))
      const tabId = await resolveTabId(args[1])
      return print(await request('advise', { evidence, tabId }))
    }
    case 'text': {
      const tabId = await resolveTabId(args[0])
      return print(await request('text', { tabId }))
    }
    case 'click': {
      if (!args[0]) throw new Error('click requires selectorOrText')
      const tabId = await resolveTabId(args[1])
      return print(await request('click', { selectorOrText: args[0], tabId }))
    }
    case 'fill': {
      if (args.length < 2) throw new Error('fill requires selectorOrPlaceholder and value')
      const tabId = await resolveTabId(args[2])
      return print(await request('fill', { selectorOrPlaceholder: args[0], value: args[1], tabId }))
    }
    case 'blur': {
      if (!args[0]) throw new Error('blur requires selectorOrPlaceholder')
      const tabId = await resolveTabId(args[1])
      return print(await request('blur', { selectorOrPlaceholder: args[0], tabId }))
    }
    case 'value': {
      if (!args[0]) throw new Error('value requires selectorOrPlaceholder')
      const tabId = await resolveTabId(args[1])
      return print(await request('value', { selectorOrPlaceholder: args[0], tabId }))
    }
    case 'key': {
      if (args.length < 3) throw new Error('key requires key, code and windowsVirtualKeyCode')
      const tabId = await resolveTabId(args[3])
      return print(await request('key', { key: args[0], code: args[1], windowsVirtualKeyCode: Number(args[2]), tabId }))
    }
    case 'reload': {
      const tabId = await resolveTabId(args[0])
      return print(await request('reload', { tabId }))
    }
    case 'shot': {
      if (!args[0]) throw new Error('shot requires an output filename')
      const tabId = await resolveTabId(args[1])
      const result = await request('screenshot', { tabId })
      await writeFile(args[0], Buffer.from(result.data, 'base64'))
      return print({ saved: args[0], bytes: Buffer.byteLength(result.data, 'base64'), tabId })
    }
    case 'eval': {
      if (!args[0]) throw new Error('eval requires JavaScript')
      const tabId = await resolveTabId(args[1])
      return print(await request('eval', { expression: args[0], tabId }))
    }
    case 'eval-file': {
      if (!args[0]) throw new Error('eval-file requires a JavaScript file')
      const expression = await readFile(args[0], 'utf8')
      const tabId = await resolveTabId(args[1])
      return print(await request('eval', { expression, tabId }))
    }
    case 'sequence': {
      if (!args[0]) throw new Error('sequence requires a JSON steps file')
      const steps = JSON.parse(await readFile(args[0], 'utf8'))
      const tabId = await resolveTabId(args[1])
      return print(await request('sequence', { steps, tabId }))
    }
    case 'sequence-json': {
      if (!args[0]) throw new Error('sequence-json requires a JSON array')
      const steps = JSON.parse(args[0])
      const tabId = await resolveTabId(args[1])
      return print(await request('sequence', { steps, tabId }))
    }
    case 'fill-enter': {
      if (args.length < 2) throw new Error('fill-enter requires selectorOrPlaceholder and value')
      const tabId = await resolveTabId(args[2])
      const steps = [
        { action: 'fill', target: args[0], value: args[1] },
        { action: 'key', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        { action: 'value', target: args[0] }
      ]
      return print(await request('sequence', { steps, tabId }))
    }
    default: throw new Error(`Unknown command: ${command}\n${USAGE}`)
  }
}

main().catch(error => {
  process.stderr.write(`ERROR: ${error.message}\n`)
  process.exitCode = 1
})
