import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exampleRoot = path.join(packageRoot, 'examples', 'agent-workspace')
const routerRoot = path.join(exampleRoot, '.agents', 'skills', 'site-workflow-router')
const router = await readFile(path.join(routerRoot, 'SKILL.md'), 'utf8')
const match = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n/s.exec(router)
assert.ok(match, 'Router Skill requires name and description frontmatter')
assert.equal(match[1], path.basename(routerRoot), 'DSH Skill name must match its one-level folder')
assert.ok(match[2].length > 20, 'Description should explain when the router applies')
assert.match(router, /references\/flow-criteria\.md/)
assert.equal((await stat(path.join(routerRoot, 'references', 'flow-criteria.md'))).isFile(), true)
const sample = await readFile(path.join(exampleRoot, 'samples', 'site-skill', 'SKILL.md'), 'utf8')
assert.match(sample, /Example-only|not an active production Skill/)
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'extension', 'manifest.json'), 'utf8'))
assert.equal(packageJson.version, manifest.version)
process.stdout.write('portable DSH Skill layout, reference, and version consistency: ok\n')
