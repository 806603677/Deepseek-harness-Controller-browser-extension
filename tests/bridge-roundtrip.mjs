import { spawn } from 'node:child_process'
import net from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const executable = path.resolve(here, '..', 'native-host', 'bin', 'DshEdgeNativeHost-0.9.0.exe')
const testPipeName = `dsh-edge-bridge-test-${process.pid}`
const runtime = await mkdtemp(path.join(os.tmpdir(), 'dsh-edge-test-'))
const child = spawn(executable, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_EDGE_PIPE_NAME: testPipeName, DSH_EDGE_RUNTIME_DIRECTORY: runtime }
})
const timeout = setTimeout(() => {
  process.stderr.write('Native Host test timed out; stderr: ' + (stderr || '(empty)') + '\n')
  child.kill()
  process.exitCode = 1
}, 15000)
let stderr = ''
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
const requestId = randomUUID()

function nativeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  return Buffer.concat([header, payload])
}

async function readFrame(stream) {
  let buffer = Buffer.alloc(0)
  while (buffer.length < 4) {
    const [chunk] = await once(stream, 'data')
    buffer = Buffer.concat([buffer, chunk])
  }
  const length = buffer.readUInt32LE(0)
  while (buffer.length < 4 + length) {
    const [chunk] = await once(stream, 'data')
    buffer = Buffer.concat([buffer, chunk])
  }
  return JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
}

await new Promise(resolve => setTimeout(resolve, 250))
const socket = net.createConnection(`\\\\.\\pipe\\${testPipeName}`)
await once(socket, 'connect')
socket.setEncoding('utf8')
socket.write(JSON.stringify({ type: 'request', requestId, method: 'status', params: {} }) + '\n')

const forwarded = await readFrame(child.stdout)
if (forwarded.requestId !== requestId || forwarded.method !== 'status') {
  throw new Error('Native Host did not forward the pipe request correctly')
}

child.stdin.write(nativeFrame({ type: 'response', requestId, ok: true, result: { roundtrip: true } }))
let responseText = ''
while (!responseText.includes('\n')) {
  const [chunk] = await once(socket, 'data')
  responseText += chunk
}
const response = JSON.parse(responseText.slice(0, responseText.indexOf('\n')))
if (!response.ok || !response.result?.roundtrip) throw new Error('Native Host did not route the extension response correctly')

const fileRequestId = randomUUID()
const requests = path.join(runtime, 'requests')
const responses = path.join(runtime, 'responses')
await mkdir(requests, { recursive: true })
await mkdir(responses, { recursive: true })
const fileRequestPath = path.join(requests, `${fileRequestId}.json`)
const fileTemporaryPath = `${fileRequestPath}.tmp`
const fileResponsePath = path.join(responses, `${fileRequestId}.json`)
await writeFile(fileTemporaryPath, JSON.stringify({ type: 'request', requestId: fileRequestId, method: 'status', params: {} }), 'utf8')
await rename(fileTemporaryPath, fileRequestPath)

const fileForwarded = await readFrame(child.stdout)
if (fileForwarded.requestId !== fileRequestId || fileForwarded.method !== 'status') {
  throw new Error('Native Host did not forward the file request correctly')
}
child.stdin.write(nativeFrame({ type: 'response', requestId: fileRequestId, ok: true, result: { fileRoundtrip: true } }))

let fileResponse = null
for (let attempt = 0; attempt < 100 && !fileResponse; attempt++) {
  try { fileResponse = JSON.parse(await readFile(fileResponsePath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!fileResponse) await new Promise(resolve => setTimeout(resolve, 50))
}
if (!fileResponse?.ok || !fileResponse.result?.fileRoundtrip) throw new Error('Native Host did not route the file response correctly')
await unlink(fileResponsePath).catch(() => {})

socket.destroy()
child.kill()
clearTimeout(timeout)
await rm(runtime, { recursive: true, force: true })
process.stdout.write('pipe and file bridge roundtrip: ok\n')
