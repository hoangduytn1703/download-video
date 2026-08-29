// Gọi YouTube bằng cookie đăng nhập CÁ NHÂN của người dùng (InnerTube + SAPISIDHASH)
// để dùng tính năng "Hỏi về video này" (Ask Gemini, Premium/Labs).
//
// Cookie là chìa khóa tài khoản Google — chỉ lưu ở máy này (file riêng trong thư mục
// cấu hình), chỉ gửi tới https://www.youtube.com, không bao giờ trả về qua API hay ghi log.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { parseSegmentsText, buildPrompt } from '../src/parse.js'
import { normalizeSegments } from './gemini.js'

const CONFIG_DIR = path.join(os.homedir(), '.youtube-download-tool')
const COOKIE_FILE = path.join(CONFIG_DIR, 'youtube-cookie.txt')
const DEBUG_DIR = path.join(CONFIG_DIR, 'ask-debug')
const ORIGIN = 'https://www.youtube.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const MARKER = 'CUT_RESULT:'

export const NO_COOKIE_MESSAGE = 'Chưa có cookie YouTube — dán cookie trong Cài đặt ⚙️ (mục YouTube cá nhân) rồi bấm Kiểm tra đăng nhập.'
export const ASK_PANEL_NOT_FOUND = 'Không thấy panel "Hỏi về video này" trên trang video với tài khoản này — tài khoản cần Premium và đã bật tính năng Hỏi Gemini (YouTube Labs). Đã lưu dữ liệu trang vào thư mục ask-debug để soi.'
export const ASK_NEED_PAYLOAD = 'Đã mở được panel Hỏi Gemini nhưng chưa gửi được câu hỏi — cần Payload của request get_panel lúc bạn gửi câu hỏi (DevTools → Payload → view source). Đã lưu request/response vào thư mục ask-debug.'

export const cookieFilePath = () => COOKIE_FILE
export const debugDirPath = () => DEBUG_DIR

// ===== Lưu / đọc cookie =====

export function loadCookie() {
  try {
    return fs.readFileSync(COOKIE_FILE, 'utf8').trim() || null
  } catch {
    return null
  }
}

export function saveCookie(cookieHeader) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = COOKIE_FILE + '.tmp'
  fs.writeFileSync(tmp, cookieHeader, 'utf8')
  fs.renameSync(tmp, COOKIE_FILE)
}

export function clearCookie() {
  try { fs.rmSync(COOKIE_FILE, { force: true }) } catch {}
}

// ===== Đọc cookie người dùng dán vào =====
// Nhận 3 kiểu: (1) header "a=b; c=d" copy từ DevTools, (2) file cookies.txt kiểu Netscape
// (7 cột tab) từ extension "Get cookies.txt", (3) JSON [{name, value, domain}].
// Chỉ giữ cookie của youtube.com / google.com.
export function parseCookieInput(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('Cookie trống')
  const pairs = new Map()
  const keepDomain = d => /(^|\.)(youtube|google)\.com$/i.test(String(d || '').replace(/^#HttpOnly_/, '').replace(/^\./, ''))

  if (raw.startsWith('[') || raw.startsWith('{')) {
    let arr
    try { arr = JSON.parse(raw) } catch { throw new Error('JSON cookie không đọc được') }
    if (!Array.isArray(arr)) arr = arr.cookies || []
    for (const c of arr) {
      if (c?.name && c?.value != null && (!c.domain || keepDomain(c.domain))) pairs.set(c.name, String(c.value))
    }
  } else if (raw.split('\n').some(l => l.split('\t').length >= 7)) {
    for (const line of raw.split('\n')) {
      if (!line.trim() || line.trim().startsWith('# ')) continue
      const cols = line.replace(/\r$/, '').split('\t')
      if (cols.length < 7) continue
      const [domain, , , , , name, value] = cols
      if (keepDomain(domain) && name) pairs.set(name.trim(), value.trim())
    }
  } else {
    const header = raw.replace(/^cookie\s*:\s*/i, '')
    for (const part of header.split(/;\s*/)) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      pairs.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
  }

  if (!pairs.size) throw new Error('Không đọc được cookie nào — copy đúng giá trị header "cookie" trong DevTools hoặc file cookies.txt')
  if (!pairs.has('SAPISID') && !pairs.has('__Secure-3PAPISID')) {
    throw new Error('Cookie thiếu SAPISID / __Secure-3PAPISID — phải copy khi đang đăng nhập YouTube (không dùng cửa sổ ẩn danh)')
  }
  const cookie = [...pairs].map(([k, v]) => `${k}=${v}`).join('; ')
  return { cookie, names: [...pairs.keys()] }
}

export function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

// ===== Chữ ký SAPISIDHASH — cách YouTube web xác thực request InnerTube =====
export function sapisidHash(sapisid, origin = ORIGIN, ts = Math.floor(Date.now() / 1000)) {
  const hex = crypto.createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex')
  return `${ts}_${hex}`
}

export function authHeaders(cookieHeader, extra = {}) {
  const sapisid = cookieValue(cookieHeader, 'SAPISID') || cookieValue(cookieHeader, '__Secure-3PAPISID')
  const p1 = cookieValue(cookieHeader, '__Secure-1PAPISID') || sapisid
  const p3 = cookieValue(cookieHeader, '__Secure-3PAPISID') || sapisid
  const ts = Math.floor(Date.now() / 1000)
  return {
    Cookie: cookieHeader,
    Authorization: `SAPISIDHASH ${sapisidHash(sapisid, ORIGIN, ts)} SAPISID1PHASH ${sapisidHash(p1, ORIGIN, ts)} SAPISID3PHASH ${sapisidHash(p3, ORIGIN, ts)}`,
    Origin: ORIGIN,
    'X-Origin': ORIGIN,
    Referer: ORIGIN + '/',
    'User-Agent': UA,
    'Accept-Language': 'vi,en;q=0.8',
    'X-Goog-AuthUser': extra.sessionIndex || '0',
    'X-Youtube-Bootstrap-Logged-In': 'true',
    'X-Youtube-Client-Name': '1',
    'X-Youtube-Client-Version': extra.clientVersion || '2.20260825.01.00',
    ...(extra.visitorData ? { 'X-Goog-Visitor-Id': extra.visitorData } : {}),
    ...(extra.pageId ? { 'X-Goog-PageId': extra.pageId } : {}),
  }
}

// ===== Lấy JSON nhúng trong HTML (ytcfg / ytInitialData) — quét ngoặc có xét chuỗi =====
export function extractJsonAfter(html, marker) {
  const at = String(html || '').indexOf(marker)
  if (at < 0) return null
  let i = html.indexOf('{', at + marker.length)
  if (i < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let j = i; j < html.length; j++) {
    const ch = html[j]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(html.slice(i, j + 1)) } catch { return null }
      }
    }
  }
  return null
}

function pickCfg(cfg) {
  if (!cfg) return {}
  return {
    clientVersion: cfg.INNERTUBE_CLIENT_VERSION,
    apiKey: cfg.INNERTUBE_API_KEY,
    visitorData: cfg.VISITOR_DATA || cfg.INNERTUBE_CONTEXT?.client?.visitorData,
    sessionIndex: cfg.SESSION_INDEX != null ? String(cfg.SESSION_INDEX) : '0',
    pageId: cfg.DELEGATED_SESSION_ID || '',
    loggedIn: Boolean(cfg.LOGGED_IN),
    context: cfg.INNERTUBE_CONTEXT,
  }
}

export async function fetchWatchPage(cookieHeader, videoId) {
  const url = `${ORIGIN}/watch?v=${videoId}&hl=vi`
  const res = await fetch(url, {
    headers: { Cookie: cookieHeader, 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8' },
  })
  if (!res.ok) throw new Error(`YouTube trả HTTP ${res.status} khi mở trang video`)
  const html = await res.text()
  const cfg = pickCfg(extractJsonAfter(html, 'ytcfg.set('))
  const initialData = extractJsonAfter(html, 'var ytInitialData = ')
  if (!initialData) throw new Error('Không đọc được dữ liệu trang video (ytInitialData) — cookie có thể đã hết hạn')
  return { url, cfg, initialData }
}

// ===== Gọi InnerTube =====
export async function innertube(cookieHeader, cfg, endpoint, body) {
  const key = cfg?.apiKey ? `&key=${encodeURIComponent(cfg.apiKey)}` : ''
  const ctx = cfg?.context || { client: { clientName: 'WEB', clientVersion: cfg?.clientVersion || '2.20260825.01.00', hl: 'vi', gl: 'VN' } }
  const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false${key}`, {
    method: 'POST',
    headers: { ...authHeaders(cookieHeader, cfg || {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: ctx, ...body }),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 200)
    throw new Error(`InnerTube ${endpoint} trả HTTP ${res.status}: ${msg}`)
  }
  return json
}

// Tên tài khoản đang đăng nhập — để người dùng chắc là cookie đúng và còn sống
export async function checkLogin(cookieHeader) {
  const data = await innertube(cookieHeader, null, 'account/account_menu', {})
  const header = findFirst(data, 'activeAccountHeaderRenderer')
  if (!header) {
    return { ok: false, message: 'Cookie không đăng nhập được — YouTube coi như khách. Copy lại cookie mới khi đang mở youtube.com đã đăng nhập.' }
  }
  const name = textOf(header.accountName)
  const channel = textOf(header.channelHandle)
  return { ok: true, accountName: name || channel || 'Đã đăng nhập', channelHandle: channel }
}

// ===== Dò panel "Hỏi về video này" trong dữ liệu trang =====
const ASK_RE = /ask|youchat|conversation|gemini|hỏi/i

export function findAskCandidates(root) {
  const out = []
  const seen = new Set()
  const walk = (node, p, depth) => {
    if (!node || typeof node !== 'object' || depth > 60) return
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${p}[${i}]`, depth + 1)); return }
    for (const [k, v] of Object.entries(node)) {
      const here = p ? `${p}.${k}` : k
      const idLike = /panelIdentifier|targetId|panelId|identifier/i.test(k) && typeof v === 'string' && ASK_RE.test(v)
      const keyLike = ASK_RE.test(k) && k !== 'task'
      if (idLike || keyLike) {
        const sig = `${k}:${typeof v === 'string' ? v : JSON.stringify(v).slice(0, 80)}`
        if (!seen.has(sig)) {
          seen.add(sig)
          out.push({ path: here, key: k, value: typeof v === 'string' ? v : undefined, endpoints: collectEndpoints(idLike ? node : v) })
        }
      }
      walk(v, here, depth + 1)
    }
  }
  walk(root, '', 0)
  return out.slice(0, 40)
}

// Gom các endpoint/command có thể dùng để gọi get_panel từ một nhánh dữ liệu
function collectEndpoints(node) {
  const found = []
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 25 || found.length >= 8) return
    if (Array.isArray(n)) { n.forEach(v => walk(v, depth + 1)); return }
    for (const [k, v] of Object.entries(n)) {
      if (/getPanelEndpoint|continuationCommand|continuationEndpoint|serviceEndpoint|commandExecutorCommand|showEngagementPanelEndpoint/i.test(k) && v && typeof v === 'object') {
        found.push({ type: k, body: v })
      }
      walk(v, depth + 1)
    }
  }
  walk(node, 0)
  return found
}

export function findFirst(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 80) return null
  if (Array.isArray(node)) {
    for (const v of node) { const r = findFirst(v, key, depth + 1); if (r) return r }
    return null
  }
  if (key in node) return node[key]
  for (const v of Object.values(node)) { const r = findFirst(v, key, depth + 1); if (r) return r }
  return null
}

function textOf(x) {
  if (!x) return ''
  if (typeof x === 'string') return x
  if (x.simpleText) return x.simpleText
  if (Array.isArray(x.runs)) return x.runs.map(r => r.text || '').join('')
  return ''
}

// Gom mọi chuỗi text hiển thị trong một response để đọc câu trả lời AI
export function collectText(node, acc = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 80) return acc
  if (Array.isArray(node)) { node.forEach(v => collectText(v, acc, depth + 1)); return acc }
  if (typeof node.simpleText === 'string') acc.push(node.simpleText)
  if (Array.isArray(node.runs)) acc.push(node.runs.map(r => r.text || '').join(''))
  if (typeof node.text === 'string' && node.text.length > 20) acc.push(node.text)
  if (typeof node.content === 'string' && node.content.length > 20) acc.push(node.content)
  for (const [k, v] of Object.entries(node)) {
    if (k === 'runs' || k === 'simpleText') continue
    collectText(v, acc, depth + 1)
  }
  return acc
}

function dump(name, data) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true })
    fs.writeFileSync(path.join(DEBUG_DIR, name), JSON.stringify(data, null, 2), 'utf8')
  } catch {}
}

function videoIdOf(url) {
  try {
    const u = new URL(url)
    if (u.hostname.replace(/^www\./, '') === 'youtu.be') return u.pathname.slice(1).split('/')[0]
    if (u.searchParams.get('v')) return u.searchParams.get('v')
    const m = u.pathname.match(/\/(shorts|live)\/([^/?]+)/)
    if (m) return m[2]
  } catch {}
  return String(url || '')
}

// Dò xem tài khoản này có thấy panel Hỏi Gemini không — trả tóm tắt cho UI, lưu chi tiết ra ask-debug
export async function probeAsk(url) {
  const cookie = loadCookie()
  if (!cookie) throw new Error(NO_COOKIE_MESSAGE)
  const videoId = videoIdOf(url)
  const page = await fetchWatchPage(cookie, videoId)
  const candidates = findAskCandidates(page.initialData)
  const panelIds = []
  for (const p of page.initialData.engagementPanels || []) {
    const r = p.engagementPanelSectionListRenderer
    if (r) panelIds.push(r.panelIdentifier || r.targetId || '(không tên)')
  }
  const summary = {
    videoId,
    loggedIn: page.cfg.loggedIn,
    clientVersion: page.cfg.clientVersion,
    engagementPanels: panelIds,
    askCandidates: candidates.map(c => ({ path: c.path, key: c.key, value: c.value, endpointTypes: c.endpoints.map(e => e.type) })),
  }
  dump(`watch-${videoId}.json`, { summary, cfg: { ...page.cfg, context: undefined }, candidates, engagementPanels: page.initialData.engagementPanels })
  return { ...summary, debugDir: DEBUG_DIR }
}

function parseAskText(text) {
  const cut = String(text || '')
  const marked = cut.includes(MARKER) ? cut.slice(cut.lastIndexOf(MARKER) + MARKER.length) : cut
  const parsed = parseSegmentsText(marked)
  return { name: parsed.name, segments: normalizeSegments(parsed.segments) }
}

// Phân tích video bằng "Hỏi về video này" của YouTube với cookie cá nhân.
// Bước gửi câu hỏi phụ thuộc payload nội bộ chưa biết chắc — nên mọi request/response
// đều được lưu vào ask-debug để hoàn thiện dần.
export async function analyzeViaCookieAsk(url, { prompt, language } = {}) {
  const cookie = loadCookie()
  if (!cookie) throw new Error(NO_COOKIE_MESSAGE)
  const videoId = videoIdOf(url)
  const page = await fetchWatchPage(cookie, videoId)
  const candidates = findAskCandidates(page.initialData)
  const withEndpoint = candidates.find(c => c.endpoints.some(e => /getPanelEndpoint|continuation/i.test(e.type)))
  dump(`watch-${videoId}.json`, { candidates, engagementPanels: page.initialData.engagementPanels })
  if (!withEndpoint) throw new Error(ASK_PANEL_NOT_FOUND)

  const ep = withEndpoint.endpoints.find(e => /getPanelEndpoint|continuation/i.test(e.type)).body
  const question = `${buildPrompt(prompt, true, language)}\n\nBắt đầu câu trả lời bằng ${MARKER}`
  // get_panel nhận panelId/params từ endpoint trên trang; kèm câu hỏi ở các tên trường
  // thường gặp — nếu YouTube dùng tên khác, response lưu trong ask-debug sẽ cho biết.
  const body = {
    videoId,
    ...(ep.panelId ? { panelId: ep.panelId } : {}),
    ...(ep.params ? { params: ep.params } : {}),
    ...(ep.continuationCommand?.token ? { continuation: ep.continuationCommand.token } : {}),
    ...(ep.token ? { continuation: ep.token } : {}),
    query: question,
  }
  const res = await innertube(cookie, page.cfg, 'get_panel', body)
  dump(`get_panel-${videoId}.json`, { request: body, response: res })
  const result = parseAskText(collectText(res).join('\n'))
  if (result.segments.length) return result
  throw new Error(ASK_NEED_PAYLOAD)
}

export { parseAskText }
