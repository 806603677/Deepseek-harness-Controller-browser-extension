import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ACCESS_POLICY, isAllowedUrl, normalizeAccessPolicy, parseOrigin, permissionPatterns } from '../extension/allowed-origins.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(path.resolve(here, '..', 'extension', 'manifest.json'), 'utf8'))

const selected = normalizeAccessPolicy({ mode: 'selected', origins: ['https://example.org', 'http://localhost:3000', 'https://example.org/'] })
assert.deepEqual(selected.origins, ['https://example.org', 'http://localhost:3000'])
assert.equal(isAllowedUrl('https://example.org/a'), false)
assert.equal(isAllowedUrl('https://example.org/a', selected), true)
assert.equal(isAllowedUrl('http://localhost:3000/path', selected), true)
assert.equal(isAllowedUrl('http://localhost:3001/path', selected), false)
assert.equal(isAllowedUrl('https://other.example.org/', selected), false)
assert.equal(isAllowedUrl('https://example.org.evil.test/', selected), false)
assert.equal(isAllowedUrl('https://user:password@example.org/', selected), false)
assert.equal(isAllowedUrl('not-a-url', selected), false)
assert.equal(isAllowedUrl('https://example.org/', DEFAULT_ACCESS_POLICY), false)
assert.equal(isAllowedUrl('https://example.org/', { mode: 'all', origins: [] }), true)
assert.equal(isAllowedUrl('http://any.test/', { mode: 'all', origins: [] }), true)
assert.equal(isAllowedUrl('file:///secret', { mode: 'all', origins: [] }), false)
assert.equal(isAllowedUrl('chrome://extensions/', { mode: 'all', origins: [] }), false)
assert.deepEqual(permissionPatterns(selected), ['https://example.org/*', 'http://localhost:3000/*'])
assert.deepEqual(permissionPatterns({ mode: 'all', origins: [] }), ['http://*/*', 'https://*/*'])
for (const invalid of ['ftp://example.org', 'https://example.org/path', 'https://example.org?x=1', 'https://u:p@example.org']) {
  assert.throws(() => parseOrigin(invalid))
}
assert.throws(() => normalizeAccessPolicy({ mode: 'everything' }))
assert.equal(manifest.host_permissions, undefined)
assert.deepEqual(manifest.optional_host_permissions, permissionPatterns({ mode: 'all', origins: [] }))

process.stdout.write('user-configured origins and optional browser permissions: ok\n')
