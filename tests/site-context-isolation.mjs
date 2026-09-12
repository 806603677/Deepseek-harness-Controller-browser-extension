import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(here, '..', 'examples', 'agent-workspace', 'scripts', 'site-context.mjs')
const controller = path.resolve(here, '..', 'scripts', 'dsh-edge.mjs')
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'dsh-site-context-test-'))
const script = path.join(sandbox, 'scripts', 'site-context.mjs')
const enter = async url => JSON.parse((await run(process.execPath, [script, 'enter', url])).stdout)
try {
  await mkdir(path.dirname(script), { recursive: true })
  await copyFile(source, script)
  await writeFile(path.join(sandbox, 'config.local.json'), JSON.stringify({
    controllerScript: controller, memoryRoot: 'memory/sites', skillsRoot: '.agents/skills',
    maxLoadedMemoryChars: 1600, maxSiteSkillTokens: 300, modelTokensPerSecond: 25,
    strictSiteBoundary: true
  }), 'utf8')
  const first = await enter('https://example.org/catalog')
  assert.equal(first.memory.length, 0)
  const siteSummary = path.join(sandbox, 'memory', 'sites', first.siteKey, 'summary.md')
  const pageSummary = path.join(sandbox, 'memory', 'sites', first.siteKey, 'pages', `${first.pageKey}.md`)
  await mkdir(path.dirname(pageSummary), { recursive: true })
  await writeFile(siteSummary, 'ONLY_SITE_A', 'utf8')
  await writeFile(pageSummary, 'ONLY_PAGE_A', 'utf8')
  const repeat = await enter('https://example.org/catalog')
  assert.equal(repeat.siteChanged, false)
  assert.equal(repeat.pageChanged, false)
  assert.deepEqual(repeat.memory.map(item => item.excerpt), ['ONLY_SITE_A', 'ONLY_PAGE_A'])
  const otherPage = await enter('https://example.org/profile')
  assert.equal(otherPage.pageChanged, true)
  assert.deepEqual(otherPage.memory.map(item => item.excerpt), ['ONLY_SITE_A'])
  const otherSite = await enter('https://other.test/catalog')
  assert.equal(otherSite.siteChanged, true)
  assert.equal(otherSite.newAgentContextRecommended, true)
  assert.deepEqual(otherSite.memory, [])
  assert.equal(JSON.stringify(otherSite).includes('ONLY_SITE_A'), false)
  const state = JSON.parse(await readFile(path.join(sandbox, '.state', 'active-site.json'), 'utf8'))
  assert.deepEqual(Object.keys(state).sort(), ['pageKey', 'siteKey', 'updatedAt'])
  process.stdout.write('site/page Memory isolation and context reset signals: ok\n')
} finally {
  if (path.basename(sandbox).startsWith('dsh-site-context-test-') && path.dirname(sandbox) === os.tmpdir()) {
    await rm(sandbox, { recursive: true, force: true })
  }
}
