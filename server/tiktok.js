// Theo dõi lượt follow kênh TikTok công khai.
//
// TikTok chặn bot nặng hơn YouTube nhiều: fetch() thuần luôn nhận trang "tường lửa" (SlardarWAF,
// ~1.4KB) thay vì trang hồ sơ. Chỉ trình duyệt Chromium thật mới qua được, nên lấy HTML theo 2 đường:
//   1. Trong app desktop: hook Electron (global.__electronFetchPage) mở cửa sổ ẩn bằng chính Chromium
//      có sẵn trong app — không tốn thêm dung lượng, không cần cài gì.
//   2. Chạy dạng web/dev hoặc hook thất bại: gọi Chrome/Edge có sẵn trên máy ở chế độ headless
//      (--dump-dom). Máy Windows nào cũng có Edge cài sẵn.
// Số liệu nằm trong <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> (tương tự ytInitialData của
// YouTube). Dùng statsV2 (số chính xác dạng chuỗi) thay cho stats (số đã làm tròn để hiển thị) —
// theo dõi tăng/giảm từng ngày cần số chính xác, số làm tròn sẽ che mất chênh lệch nhỏ.
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ===== Khóa tính năng bằng mật khẩu =====
// Chỉ lưu mã băm (SHA-256 + salt), không có mật khẩu dạng chữ trong code/repo. So sánh timing-safe.
const TIKTOK_PASS_SALT = 'ytdl-tiktok-gate-v1'
export const TIKTOK_PASS_SHA256 = 'ae75acada6bd0a756463611b52f0ec9ef004cf3636be4ecbd1a026f17a69b1b2'
export function hashTikTokPassword(p) {
  return crypto.createHash('sha256').update(TIKTOK_PASS_SALT + ':' + String(p ?? '')).digest('hex')
}
export function verifyTikTokPassword(input, expectedHex = TIKTOK_PASS_SHA256) {
  if (typeof input !== 'string' || !input) return false
  const a = Buffer.from(hashTikTokPassword(input), 'hex')
  const b = Buffer.from(String(expectedHex), 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// Link kênh: dùng chung với frontend (src/tiktok-url.js)
export { isTikTokUrl, tiktokHandle, tiktokProfileUrl, normalizeTikTokInput } from '../src/tiktok-url.js'

// ===== Đọc số liệu từ HTML trang hồ sơ =====
export function extractRehydrationData(html) {
  const m = String(html || '').match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

// Trang tường lửa của TikTok: rất ngắn, có cấu hình SlardarWAF, không có dữ liệu trang
export function looksBlocked(html) {
  const h = String(html || '')
  return !h.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__') && (/SlardarWAF|slardar_us_waf/.test(h) || h.length < 5000)
}

// Tìm node userInfo {user:{uniqueId}, stats/statsV2} ở bất kỳ đâu trong JSON (không phụ thuộc path cố định)
function findUserInfo(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null
  if (node.user && typeof node.user === 'object' && node.user.uniqueId && (node.statsV2 || node.stats)) return node
  for (const v of Object.values(node)) {
    const r = findUserInfo(v, depth + 1)
    if (r) return r
  }
  return null
}

const num = v => {
  const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : Number(v)
  return Number.isFinite(n) ? n : null
}

// Trả { handle, nickname, avatar, followers, following, hearts, videos } hoặc ném lỗi dễ hiểu
export function parseTikTokStats(html) {
  const data = extractRehydrationData(html)
  if (!data) {
    if (looksBlocked(html)) throw new Error('TikTok chặn truy cập tự động (tường lửa) — thử lại sau ít phút')
    throw new Error('Không đọc được dữ liệu trang TikTok (cấu trúc trang có thể đã đổi)')
  }
  const info = findUserInfo(data)
  if (!info) {
    const detail = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']
    const code = detail?.statusCode
    if (code === 10221 || code === 10222 || /not found|user_not_found/i.test(String(detail?.statusMsg || ''))) {
      throw new Error('Không tìm thấy kênh này trên TikTok (sai tên hoặc kênh đã đổi tên/bị khóa)')
    }
    if (detail?.statusCode && detail.statusCode !== 0) {
      throw new Error('TikTok không trả dữ liệu kênh (mã ' + detail.statusCode + (detail.statusMsg ? ': ' + detail.statusMsg : '') + ')')
    }
    throw new Error('Trang TikTok không có số liệu kênh (kênh riêng tư hoặc bị chặn theo vùng?)')
  }
  const v2 = info.statsV2 || {}
  const v1 = info.stats || {}
  const pick = (a, b) => (num(a) ?? num(b))
  const followers = pick(v2.followerCount, v1.followerCount)
  if (followers === null) throw new Error('Không đọc được số follower của kênh')
  return {
    handle: String(info.user.uniqueId || '').toLowerCase(),
    nickname: String(info.user.nickname || info.user.uniqueId || ''),
    avatar: String(info.user.avatarThumb || info.user.avatarMedium || info.user.avatarLarger || ''),
    verified: Boolean(info.user.verified),
    followers,
    following: pick(v2.followingCount, v1.followingCount),
    hearts: pick(v2.heartCount ?? v2.heart, v1.heartCount ?? v1.heart),
    videos: pick(v2.videoCount, v1.videoCount),
  }
}

// ===== Lấy HTML =====
function candidateBrowsers() {
  const list = []
  if (process.env.TIKTOK_BROWSER_PATH) list.push(process.env.TIKTOK_BROWSER_PATH)
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA || ''
    list.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    )
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
        list.push(path.join(dir, n))
      }
    }
  }
  return list.filter(Boolean)
}

export function findBrowser() {
  for (const p of candidateBrowsers()) {
    try { if (fs.existsSync(p)) return p } catch {}
  }
  return null
}

// Profile Chrome riêng, CỐ ĐỊNH cho việc đọc TikTok: (1) không đụng Chrome đang mở của người
// dùng (không có --user-data-dir thì lệnh chỉ mở tab mới rồi thoát, không in gì); (2) cookie/
// device-id giữ lại giữa các lần chạy — TikTok dễ tính với "trình duyệt quen" hơn máy lạ mỗi lần.
export const tiktokProfileDir = path.join(os.homedir(), '.youtube-download-tool', 'tiktok-profile')

// Chrome/Edge headless: in DOM sau khi JS chạy xong.
export function headlessDump(bin, url, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(tiktokProfileDir, { recursive: true }) } catch {}
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-sync', '--mute-audio', '--hide-scrollbars',
      '--window-size=1280,900', '--virtual-time-budget=12000',
      '--user-data-dir=' + tiktokProfileDir, '--user-agent=' + UA,
      '--dump-dom', url,
    ]
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error('Trình duyệt không trả trang TikTok sau ' + Math.round(timeoutMs / 1000) + 's'))
    }, timeoutMs)
    child.stdout.on('data', c => chunks.push(c))
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('Không chạy được trình duyệt: ' + err.message))
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

// Trả { html, via } — via: 'electron' | tên file trình duyệt
async function fetchTikTokHtmlOnce(url) {
  let lastErr = null
  if (typeof global.__electronFetchPage === 'function') {
    try {
      const html = await global.__electronFetchPage(url)
      if (!looksBlocked(html)) return { html, via: 'electron' }
      lastErr = new Error('TikTok chặn cửa sổ ẩn của app')
    } catch (e) {
      lastErr = e
    }
  }
  const bin = findBrowser()
  if (!bin) {
    throw lastErr || new Error('Cần Chrome hoặc Edge cài trên máy để đọc TikTok (TikTok chặn truy cập tự động thông thường)')
  }
  const html = await headlessDump(bin, url)
  return { html, via: path.basename(bin) }
}

// Chạy TUẦN TỰ: một profile Chrome không mở được 2 instance cùng lúc (instance sau thoát ngay,
// không in gì), và gọi TikTok dồn dập cũng dễ bị nghi ngờ hơn.
let queue = Promise.resolve()
export function fetchTikTokHtml(url) {
  const run = queue.then(() => fetchTikTokHtmlOnce(url))
  queue = run.catch(() => {})
  return run
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Lỗi chắc chắn (kênh không tồn tại, riêng tư) thì báo ngay; còn lại (tường lửa, trang thiếu dữ
// liệu — TikTok đôi khi trả biến thể trang chưa kịp nhúng số liệu) thì thử lại vài lần.
export async function fetchTikTokStats(url, { attempts = 3 } = {}) {
  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(2000 * i)
    try {
      const { html, via } = await fetchTikTokHtml(url)
      return { ...parseTikTokStats(html), via, attempts: i + 1 }
    } catch (e) {
      lastErr = e
      if (/Không tìm thấy kênh|riêng tư|Cần Chrome|Không chạy được/.test(e?.message || '')) throw e
    }
  }
  throw lastErr
}

// ===== Lịch sử theo dõi (lưu trong config) =====
// tracked: [{ handle, url, nickname, avatar, addedAt, history: [{ day, at, followers, following, hearts, videos }] }]
// Mỗi ngày (theo giờ máy) giữ 1 mốc — bấm cập nhật nhiều lần trong ngày thì ghi đè mốc hôm nay,
// so sánh luôn tính với mốc gần nhất của NGÀY TRƯỚC (đúng nghĩa "so với hôm trước").
export function dayKey(ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export const HISTORY_LIMIT = 400

export function appendSnapshot(history, snap, now = Date.now()) {
  const day = dayKey(now)
  const entry = { day, at: now, followers: snap.followers, following: snap.following, hearts: snap.hearts, videos: snap.videos }
  const list = Array.isArray(history) ? history.filter(h => h && h.day !== day) : []
  list.push(entry)
  list.sort((a, b) => a.at - b.at)
  return list.slice(-HISTORY_LIMIT)
}

// Tóm tắt cho giao diện: mốc mới nhất, mốc ngày trước, chênh lệch, mốc đầu tiên
export function summarizeHistory(history) {
  const list = Array.isArray(history) ? [...history].sort((a, b) => a.at - b.at) : []
  const latest = list[list.length - 1] || null
  if (!latest) return { latest: null, previous: null, first: null, delta: null, deltaFromFirst: null, daysBetween: null }
  const previous = [...list].reverse().find(h => h.day < latest.day) || null
  // Mốc đầu tiên chỉ đáng hiện khi khác cả mốc mới nhất lẫn mốc ngày trước (từ 3 ngày trở lên)
  const first = list[0] !== latest && list[0] !== previous ? list[0] : null
  const diff = (a, b) => (a && b && a.followers != null && b.followers != null ? a.followers - b.followers : null)
  const days = (a, b) => (a && b ? Math.round((a.at - b.at) / 86400000) : null)
  return {
    latest,
    previous,
    first,
    delta: previous ? { followers: diff(latest, previous), following: latest.following - previous.following, hearts: latest.hearts - previous.hearts, videos: latest.videos - previous.videos } : null,
    daysBetween: previous ? Math.max(1, days(latest, previous)) : null,
    deltaFromFirst: first ? diff(latest, first) : null,
    daysFromFirst: first ? Math.max(1, days(latest, first)) : null,
  }
}
