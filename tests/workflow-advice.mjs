import assert from 'node:assert/strict'
import { assessWorkflow } from '../extension/workflow-advice.js'

const base = {
  kind: 'task', completedRuns: 2, stableRuns: 2, stepCount: 5,
  estimatedSavedSeconds: 45, proposedSkillTokens: 180,
  modelTokensPerSecond: 25, maxSkillTokens: 300, authInterruptions: 0
}
assert.equal(assessWorkflow(base).decision, 'ask_user_before_skill')
assert.equal(assessWorkflow(base).requiresUserConsent, true)
assert.equal(assessWorkflow({ ...base, kind: 'navigation', stepCount: 2 }).decision, 'compact_map_only')
assert.equal(assessWorkflow({ ...base, completedRuns: 1 }).decision, 'observe_more')
assert.equal(assessWorkflow({ ...base, stableRuns: 1 }).decision, 'observe_more')
assert.equal(assessWorkflow({ ...base, authInterruptions: 1 }).decision, 'split_at_auth')
assert.equal(assessWorkflow({ ...base, proposedSkillTokens: 500 }).decision, 'trim_or_memory_only')
assert.equal(assessWorkflow({ ...base, estimatedSavedSeconds: 8 }).decision, 'compact_map_only')
assert.equal(assessWorkflow({ ...base, modelTokensPerSecond: 5, estimatedSavedSeconds: 30 }).decision, 'compact_map_only')
assert.equal(assessWorkflow({ ...base, proposedSkillTokens: 0 }).decision, 'estimate_cost')
process.stdout.write('workflow promotion thresholds and small-model cost: ok\n')
