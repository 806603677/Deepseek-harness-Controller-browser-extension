import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import os from 'node:os'

export async function headlessBrowser() {
  const executable = [process.env.DSH_TEST_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome'].find(file => file && existsSync(file))
  if (!executable) throw new Error('Set DSH_TEST_BROWSER to a Chromium/Edge executable for isolated browser tests')
  const profile = await mkdtemp(path.join(os.tmpdir(), 'dsh-efficiency-browser-'))
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let sequence = 0, stderr = '', socket
  const pending = new Map()
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  const failAll = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
  }
  child.on('error', failAll)
  child.on('exit', () => failAll(new Error(`Headless browser exited: ${stderr}`)))
  const onMessage = event => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}; ${stderr}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const close = async () => {
    const exited = child.exitCode !== null ? Promise.resolve() : once(child, 'exit').catch(() => {})
    try { if (socket?.readyState === WebSocket.OPEN) await send('Browser.close'); else child.kill() } catch { child.kill() }
    socket?.close()
    await exited
    failAll(new Error('Browser test finished'))
    // Only this test's freshly-created profile is removed.
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('dsh-efficiency-browser-')) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        .catch(error => process.stderr.write(`Test profile retained (${error.code}): ${profile}\n`))
    }
  }
  try {
    let endpoint
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Browser exited before startup: ${stderr}`)
      try {
        const [port, route] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
        if (/^\d+$/.test(port) && route?.startsWith('/devtools/browser/')) {
          endpoint = `ws://127.0.0.1:${port}${route}`
          break
        }
      } catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!endpoint) throw new Error(`Browser did not expose the test endpoint: ${stderr}`)
    socket = new WebSocket(endpoint)
    socket.addEventListener('message', onMessage)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('Browser test WebSocket failed')), { once: true })
    })
    await send('Browser.getVersion')
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    return { send: (method, params) => send(method, params, sessionId), close }
  } catch (error) { process.stderr.write(`Browser startup failed: ${error.message}\n`); await close(); throw error }
}
