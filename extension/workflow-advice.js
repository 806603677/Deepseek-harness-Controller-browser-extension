// Advisory only. The bridge never writes an agent's Memory or Skill.
export function assessWorkflow(input = {}) {
  const evidence = {
    kind: input.kind === 'navigation' ? 'navigation' : 'task',
    completedRuns: Math.max(0, Number(input.completedRuns) || 0),
    stableRuns: Math.max(0, Number(input.stableRuns) || 0),
    stepCount: Math.max(0, Number(input.stepCount) || 0),
    estimatedSavedSeconds: Math.max(0, Number(input.estimatedSavedSeconds) || 0),
    proposedSkillTokens: Math.max(0, Number(input.proposedSkillTokens) || 0),
    modelTokensPerSecond: Math.max(1, Number(input.modelTokensPerSecond) || 25),
    authInterruptions: Math.max(0, Number(input.authInterruptions) || 0),
    maxSkillTokens: Math.max(80, Math.min(1000, Number(input.maxSkillTokens) || 300))
  }
  const readCostSeconds = Math.ceil(evidence.proposedSkillTokens / evidence.modelTokensPerSecond) + 2
  const result = (decision, reason) => ({ decision, reason, readCostSeconds, evidence,
    requiresUserConsent: decision === 'ask_user_before_skill' })

  if (evidence.authInterruptions > 0) {
    return result('split_at_auth', 'Authentication, CAPTCHA, or OCR challenges are a stop boundary; do not standardize a bypass or repeated challenge handling.')
  }
  if (evidence.kind === 'navigation' && evidence.stepCount <= 3) {
    return result('compact_map_only', 'A short entry/field map is cheaper than a dedicated workflow Skill; execute known steps in one bounded batch after a current-page check.')
  }
  if (evidence.completedRuns < 2 || evidence.stableRuns < 2) {
    return result('observe_more', 'Need at least two completed runs with the same verified structure before standardizing a workflow.')
  }
  if (!evidence.proposedSkillTokens || !evidence.estimatedSavedSeconds) {
    return result('estimate_cost', 'Estimate the concise Skill size and per-run time saving before asking the user.')
  }
  if (evidence.proposedSkillTokens > evidence.maxSkillTokens) {
    return result('trim_or_memory_only', 'Proposed Skill exceeds the site budget; keep only routing and invariants, move field detail to site Memory, then reassess.')
  }
  if (evidence.estimatedSavedSeconds <= readCostSeconds + 5) {
    return result('compact_map_only', 'Reading the Skill would cost nearly as much as the expected time saving.')
  }
  if (evidence.stepCount < 4 && evidence.estimatedSavedSeconds < 30) {
    return result('compact_map_only', 'The workflow is too short to justify a separate Skill.')
  }
  return result('ask_user_before_skill', 'Repeated, stable work is likely to save net time; obtain the user’s explicit consent before writing a site Skill.')
}
