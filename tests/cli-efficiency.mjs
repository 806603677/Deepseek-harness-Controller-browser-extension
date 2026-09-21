import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-efficiency-cli-'))
const script = path.join(temp, 'scripts', 'dsh-edge.mjs')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-efficiency-cli-${process.pid}` : path.join(temp, 'bridge.sock')
const requests = []
const server = net.createServer(socket => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    if (!buffer.includes('\n')) return
    const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
    requests.push(message)
    const result = message.method === 'sequence' ? { success: false, failedIndex: 0, steps: [] } : { received: message.params }
    const reply = message.method === 'assert'
      ? { ok: false, error: 'Expected value not observed', code: 'CONDITION_TIMEOUT', details: { actual: 'old', expected: 'new' } }
      : { ok: true, result }
    socket.end(JSON.stringify({ requestId: message.requestId, ...reply }) + '\n')
  })
})
let poller
try {
  await mkdir(path.dirname(script))
  await copyFile(new URL('../scripts/dsh-edge.mjs', import.meta.url), script)
  server.listen(pipe)
  await once(server, 'listening')
  const env = { ...process.env, DSH_EDGE_TRANSPORT: 'pipe', DSH_EDGE_PIPE: pipe, DSH_EDGE_TIMEOUT_MS: '3000' }
  const cli = (args, overrides = {}) => run(process.execPath, [script, ...args], { env: { ...env, ...overrides }, timeout: 10000 })
  const compact = JSON.parse((await cli(['dom', '42', '--compact', '--scope', 'css=#panel', '--fields', 'text,value', '--values', '--limit', '5', '--since', 'baseline'])).stdout)
  assert.deepEqual(compact.received, { tabId: '42', options: { mode: 'compact', scope: 'css=#panel', fields: ['text', 'value'], includeValues: true, limit: 5, since: 'baseline' } })
  assert.deepEqual(JSON.parse((await cli(['dom', '42'])).stdout).received, { tabId: '42' })
  assert.deepEqual(JSON.parse((await cli(['dom', '42', '--full'])).stdout).received, { tabId: '42', options: { mode: 'full' } })
  assert.deepEqual(JSON.parse((await cli(['dom', '42', '--focus', 'css=#panel'])).stdout).received,
    { tabId: '42', options: { mode: 'focus', target: 'css=#panel' } })
  await assert.rejects(cli(['dom', '42', '--full', '--text']), /cannot be combined/)
  const condition = path.join(temp, 'condition.json')
  await writeFile(condition, JSON.stringify({ target: 'css=#result', condition: 'text', equals: 'done', timeoutMs: 500 }))
  await cli(['wait-for', condition, '42'])
  assert.equal(requests.at(-1).method, 'waitFor')
  await assert.rejects(cli(['assert', condition, '42']), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /CONDITION_TIMEOUT/)
    assert.match(error.stderr, /"actual":"old"/)
    return true
  })
  await assert.rejects(cli(['sequence-json', '[{"action":"wait","ms":1}]', '42']), error => {
    assert.equal(error.code, 1)
    assert.equal(JSON.parse(error.stdout).failedIndex, 0)
    return true
  })
  const beforeInvalid = requests.length
  await assert.rejects(cli(['dom', '42', '--limit']), /requires a value/)
  assert.equal(requests.length, beforeInvalid)

  // A failed cached file-bridge request must never fall through to Pipe and replay.
  const runtime = path.join(temp, 'runtime')
  await mkdir(path.join(runtime, 'requests'), { recursive: true })
  await mkdir(path.join(runtime, 'responses'), { recursive: true })
  await writeFile(path.join(runtime, 'transport-preference.json'), JSON.stringify({ transport: 'file', until: Date.now() + 60000 }))
  const seen = new Set()
  let fileError
  poller = setInterval(async () => {
    try {
      for (const name of await readdir(path.join(runtime, 'requests'))) {
        if (!name.endsWith('.json') || seen.has(name)) continue
        seen.add(name)
        const message = JSON.parse(await readFile(path.join(runtime, 'requests', name), 'utf8'))
        await writeFile(path.join(runtime, 'responses', name), JSON.stringify({ requestId: message.requestId, ok: false,
          error: 'Expected value not observed', code: 'CONDITION_TIMEOUT', details: { actual: 'old' } }))
      }
    } catch (error) { fileError = error }
  }, 20)
  const before = requests.length
  await assert.rejects(cli(['assert', condition, '42'], { DSH_EDGE_TRANSPORT: 'auto' }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /CONDITION_TIMEOUT/)
    return true
  })
  clearInterval(poller)
  assert.equal(fileError, undefined)
  assert.equal(seen.size, 1)
  assert.equal(requests.length, before, 'a failed file request is not retried over Pipe')
  process.stdout.write('CLI options, assertion diagnostics, sequence exit status and no request replay: ok\n')
} finally {
  clearInterval(poller)
  server.close()
  if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('dsh-efficiency-cli-')) await rm(temp, { recursive: true, force: true })
}
