export function runtime() {
  const loc = typeof location !== 'undefined' ? location : null
  return {
    dev: Boolean(import.meta.env?.DEV),
    envUrl: import.meta.env?.VITE_API_URL || '',
    hostname: loc?.hostname || '',
    protocol: loc?.protocol || '',
    // App desktop (Electron) nạp trang từ file:// và truyền cổng backend qua ?api=
    queryApi: loc ? new URLSearchParams(loc.search).get('api') || '' : '',
  }
}

export function getApiBase({
  dev = false,
  envUrl = '',
  hostname = '',
  protocol = '',
  queryApi = '',
} = {}) {
  const trim = v => (v || '').trim().replace(/\/$/, '')
  // App desktop chọn cổng trống lúc chạy nên phải ưu tiên giá trị nó truyền vào
  const fromQuery = trim(queryApi)
  if (fromQuery) return fromQuery
  const fromEnv = trim(envUrl)
  if (fromEnv) return fromEnv
  if (dev) return '' // Vite dev proxy /api -> localhost:3001
  // Bản đóng gói mở bằng file:// mà thiếu ?api= thì dùng cổng mặc định
  if (protocol === 'file:') return 'http://localhost:3001'
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
