// Read-only polling. Callers execute an action once, then poll its expected result.
export function conditionOptions(input = {}) {
  const options = { condition: 'visible', timeoutMs: 5000, intervalMs: 100, ...input }
  const supported = ['visible', 'hidden', 'attached', 'detached', 'enabled', 'disabled', 'clickable', 'value', 'text', 'checked', 'count']
  if (typeof options.target !== 'string' || !options.target.trim()) throw new Error('Condition target is required')
  if (!supported.includes(options.condition)) throw new Error(`Unknown condition: ${options.condition}`)
  for (const [key, min, max] of [['timeoutMs', 0, 60000], ['intervalMs', 20, 1000]]) {
    if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max) throw new Error(`${key} must be between ${min} and ${max}`)
  }
  if (['value', 'text', 'checked', 'count'].includes(options.condition)) {
    const hasEquals = Object.hasOwn(options, 'equals')
    const hasIncludes = Object.hasOwn(options, 'includes')
    if (hasEquals === hasIncludes) throw new Error('Provide exactly one of equals or includes')
    if (hasIncludes && (!['value', 'text'].includes(options.condition) || typeof options.includes !== 'string')) throw new Error('includes requires a string and a text/value condition')
    if (options.condition === 'count' && (!Number.isInteger(options.equals) || options.equals < 0)) throw new Error('count equals must be a non-negative integer')
    if (options.condition === 'checked' && typeof options.equals !== 'boolean') throw new Error('checked equals must be boolean')
    if (['value', 'text'].includes(options.condition) && hasEquals && typeof options.equals !== 'string') throw new Error('text/value equals must be a string')
  }
  return options
}

export async function pollCondition(probe, input, { now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const options = conditionOptions(input)
  const started = now()
  let attempts = 0
  let observation
  let stableSince = started
  let previousGeometry
  while (true) {
    attempts++
    observation = await probe(options)
    const elapsedMs = Math.round(now() - started)
    let stable = true
    if (options.condition === 'clickable') {
      const geometry = JSON.stringify([observation.actual?.locator, observation.actual?.geometry])
      if (!observation.met || geometry !== previousGeometry) stableSince = now()
      previousGeometry = geometry
      stable = now() - stableSince >= 100
    }
    if (observation.met && stable) return { matched: true, condition: options.condition, target: options.target, actual: observation.actual, attempts, elapsedMs }
    if (elapsedMs >= options.timeoutMs) {
      const error = new Error(`Condition timed out: ${options.condition} (${options.target})`)
      error.code = 'CONDITION_TIMEOUT'
      error.details = { condition: options.condition, target: options.target,
        ...(Object.hasOwn(options, 'equals') ? { expected: options.equals } : {}),
        ...(Object.hasOwn(options, 'includes') ? { includes: options.includes } : {}),
        actual: observation.actual, attempts, elapsedMs }
      throw error
    }
    await sleep(Math.min(options.intervalMs, options.timeoutMs - elapsedMs))
  }
}
