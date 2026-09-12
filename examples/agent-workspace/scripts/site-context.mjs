#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(workspace, 'config.local.json')
const statePath = path.join(workspace, '.state', 'active-site.json')
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const exists = async filename => stat(filename).then(info => info.isFile()).catch(() => false)

function routeTemplate(pathname) {
  return pathname.split('/').map(segment =>
    /^\d{3,}$|^[0-9a-f]{8}-[0-9a-f-]{20,}$|^[0-9a-f]{16,}$/i.test(segment) ? ':id' : segment).join('/')
}

async function config() {
  let value
  try { value = JSON.parse(await readFile(configPath, 'utf8')) }
  catch { throw new Error('Copy config.example.json to config.local.json and set the real DSH paths first') }
  if (!value.controllerScript || /REPLACE_ME/.test(value.controllerScript) || !await exists(value.controllerScript)) {
    throw new Error('controllerScript must point to the installed dsh-edge.mjs on this machine')
  }
  if (!value.memoryRoot || !value.skillsRoot) throw new Error('memoryRoot and skillsRoot are required')
  return {
    ...value,
    memoryRoot: path.resolve(workspace, value.memoryRoot),
    skillsRoot: path.resolve(workspace, value.skillsRoot),
    maxLoadedMemoryChars: Math.max(200, Math.min(5000, Number(value.maxLoadedMemoryChars) || 1600)),
    maxSiteSkillTokens: Math.max(80, Math.min(1000, Number(value.maxSiteSkillTokens) || 300)),
    modelTokensPerSecond: Math.max(1, Number(value.modelTokensPerSecond) || 25)
  }
}

async function preview(filename, remaining) {
  if (!await exists(filename)) return null
  const content = await readFile(filename, 'utf8')
  return { path: filename, excerpt: content.slice(0, remaining), truncated: content.length > remaining }
}

async function main() {
  const [command, rawUrl] = process.argv.slice(2)
  const settings = await config()
  if (command === 'check') {
    process.stdout.write(JSON.stringify({ ok: true, controllerScript: settings.controllerScript,
      memoryRoot: settings.memoryRoot, skillsRoot: settings.skillsRoot,
      maxSiteSkillTokens: settings.maxSiteSkillTokens, modelTokensPerSecond: settings.modelTokensPerSecond }, null, 2) + '\n')
    return
  }
  if (command !== 'enter' || !rawUrl) throw new Error('Usage: node scripts/site-context.mjs check | enter <http(s)-origin-and-path-without-query>')
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Pass only the current HTTP(S) origin and path; remove credentials, query and fragment')
  }
  const siteKey = `${url.hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32)}-${digest(url.origin)}`
  const pageKey = digest(`${url.origin}|${routeTemplate(url.pathname)}`)
  let previous = null
  try { previous = JSON.parse(await readFile(statePath, 'utf8')) } catch {}
  const siteChanged = Boolean(previous && previous.siteKey !== siteKey)
  const pageChanged = Boolean(previous && (previous.siteKey !== siteKey || previous.pageKey !== pageKey))

  const siteMemory = path.join(settings.memoryRoot, siteKey, 'summary.md')
  const pageMemory = path.join(settings.memoryRoot, siteKey, 'pages', `${pageKey}.md`)
  const skill = path.join(settings.skillsRoot, `site-${siteKey}`, 'SKILL.md')
  const memory = []
  let remaining = settings.maxLoadedMemoryChars
  for (const [scope, filename] of [['site', siteMemory], ['page', pageMemory]]) {
    const item = await preview(filename, remaining)
    if (item) {
      memory.push({ scope, ...item })
      remaining = Math.max(0, remaining - item.excerpt.length)
    }
  }
  let skillTokens = null
  if (await exists(skill)) skillTokens = Math.ceil(Buffer.byteLength(await readFile(skill, 'utf8'), 'utf8') / 3)

  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify({ siteKey, pageKey, updatedAt: new Date().toISOString() }), 'utf8')
  process.stdout.write(JSON.stringify({
    origin: url.origin, routeTemplate: routeTemplate(url.pathname), siteKey, pageKey,
    siteChanged, pageChanged, clearPreviousPageContext: pageChanged,
    newAgentContextRecommended: siteChanged && settings.strictSiteBoundary === true,
    memory, siteSkill: skillTokens == null ? null : { path: skill, estimatedTokens: skillTokens,
      overBudget: skillTokens > settings.maxSiteSkillTokens },
    next: memory.length ? 'Use only this site/page Memory, then verify the current page' : 'No matching Memory: run controller guide, then decide whether the work merits a workflow'
  }, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(`ERROR: ${error.message}\n`)
  process.exitCode = 1
})
