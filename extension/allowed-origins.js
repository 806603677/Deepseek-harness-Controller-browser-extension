// The browser's site access setting is authoritative for these origins.
export function permissionPatternForUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return `${url.origin}/*`
  } catch {
    return null
  }
}
