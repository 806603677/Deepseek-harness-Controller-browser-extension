// Fail closed until the browser user explicitly chooses sites in the popup.
export const DEFAULT_ACCESS_POLICY = Object.freeze({ mode: 'selected', origins: [] })

export function parseOrigin(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Enter a complete http:// or https:// origin')
  let url
  try { url = new URL(input.trim()) } catch { throw new Error(`Invalid site origin: ${input}`) }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Use an http(s) origin without a path, credentials, query or fragment: ${input}`)
  }
  return url.origin
}

export function normalizeAccessPolicy(policy) {
  if (!policy || !['all', 'selected'].includes(policy.mode)) throw new Error('Invalid access mode')
  if (policy.mode === 'all') return { mode: 'all', origins: [] }
  if (!Array.isArray(policy.origins) || policy.origins.length > 100) throw new Error('Select at most 100 site origins')
  return { mode: 'selected', origins: [...new Set(policy.origins.map(parseOrigin))] }
}

export function isAllowedUrl(rawUrl, policy = DEFAULT_ACCESS_POLICY) {
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    return policy.mode === 'all' || (policy.mode === 'selected' && policy.origins.includes(url.origin))
  } catch {
    return false
  }
}

export function permissionPatterns(policy) {
  const normalized = normalizeAccessPolicy(policy)
  return normalized.mode === 'all'
    ? ['http://*/*', 'https://*/*']
    : normalized.origins.map(origin => `${origin}/*`)
}
