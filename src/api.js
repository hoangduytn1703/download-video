export function runtime() {
  return {
    dev: Boolean(import.meta.env?.DEV),
    envUrl: import.meta.env?.VITE_API_URL || '',
    hostname: typeof location !== 'undefined' ? location.hostname : '',
  }
}

export function getApiBase({
  dev = false,
  envUrl = '',
  hostname = '',
} = {}) {
  const fromEnv = (envUrl || '').trim().replace(/\/$/, '')
  if (fromEnv) return fromEnv
  if (dev) return ''
  // GitHub Pages is static — never call the visitor's localhost.
  if (hostname.endsWith('github.io')) return ''
  return ''
}

export function apiUrl(path, options) {
  const base = getApiBase(options)
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}
