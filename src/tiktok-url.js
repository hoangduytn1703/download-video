// Nhận diện / chuẩn hóa link kênh TikTok — dùng chung cho frontend (validate khi gõ) và server.

// Link hồ sơ: tiktok.com/@handle (cho phép www./m., ?query, / cuối). Link video (/@x/video/123) không tính.
export function isTikTokUrl(url) {
  try {
    const u = new URL(String(url).trim())
    if (!/^(www\.|m\.)?tiktok\.com$/i.test(u.hostname)) return false
    return /^\/@[\w.\-]{1,60}\/?$/.test(u.pathname)
  } catch {
    return false
  }
}

export function tiktokHandle(url) {
  try {
    const m = new URL(String(url).trim()).pathname.match(/^\/@([\w.\-]{1,60})/)
    return m ? m[1].toLowerCase() : ''
  } catch {
    return ''
  }
}

export function tiktokProfileUrl(handle) {
  return 'https://www.tiktok.com/@' + String(handle || '').replace(/^@/, '')
}

// Người dùng có thể gõ "@ten" hoặc "ten" thay cho link đầy đủ — đổi về link hồ sơ
export function normalizeTikTokInput(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (/^@?[\w.\-]{1,60}$/.test(s)) return tiktokProfileUrl(s)
  return s
}

// Dán nhiều link một lần (mỗi dòng / cách nhau bởi khoảng trắng, phẩy). Trả link hồ sơ đã chuẩn hóa,
// bỏ trùng; token không hợp lệ trả riêng để báo. Chữ trần không có "@" chỉ được coi là tên kênh
// khi người dùng nhập đúng 1 token (tránh biến từ ngữ lẫn trong đoạn dán thành kênh ảo).
export function parseTikTokInputs(text) {
  const tokens = String(text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  const urls = []
  const invalid = []
  const seen = new Set()
  for (const t of tokens) {
    const bareWord = !/^https?:\/\//i.test(t) && !t.startsWith('@')
    if (bareWord && tokens.length > 1) { invalid.push(t); continue }
    const u = normalizeTikTokInput(t)
    if (!isTikTokUrl(u)) { invalid.push(t); continue }
    const h = tiktokHandle(u)
    if (seen.has(h)) continue
    seen.add(h)
    urls.push(tiktokProfileUrl(h))
  }
  return { urls, invalid }
}
