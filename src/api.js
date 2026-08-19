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
  if (dev) return '' // Vite dev proxy /api -> localhost:3001
  // Trang Pages chỉ là giao diện — backend chạy trên máy người xem (localhost).
  // Trình duyệt cho phép trang HTTPS gọi localhost (secure context exception).
  if (hostname.endsWith('github.io')) return 'http://localhost:3001'
  return ''
}

export function apiUrl(path, options) {
  const base = getApiBase(options)
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}
