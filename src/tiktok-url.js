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
