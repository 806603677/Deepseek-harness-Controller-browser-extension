import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { permissionPatternForUrl } from '../extension/allowed-origins.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(path.resolve(here, '..', 'extension', 'manifest.json'), 'utf8'))

assert.equal(permissionPatternForUrl('https://example.org/a?x=1'), 'https://example.org/*')
assert.equal(permissionPatternForUrl('http://localhost:3000/path'), 'http://localhost:3000/*')
for (const invalid of ['ftp://example.org', 'file:///secret', 'chrome://extensions/', 'https://u:p@example.org/', 'not-a-url']) {
  assert.equal(permissionPatternForUrl(invalid), null)
}
assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*'])
assert.equal(manifest.optional_host_permissions, undefined)

process.stdout.write('browser-managed host permissions and supported origins: ok\n')
