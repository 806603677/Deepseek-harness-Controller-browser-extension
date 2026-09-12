import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const html = await readFile(new URL('./fixtures/generic-form.html', import.meta.url))
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`http://127.0.0.1:${address.port}/\n`)
})
