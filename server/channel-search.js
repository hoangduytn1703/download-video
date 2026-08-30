// Tìm kiếm / đề xuất clip từ một channel YouTube.
// Lấy danh sách video công khai của channel (lockupViewModel), xếp theo lượt xem hoặc
// ngày đăng, lọc theo từ khóa nếu có, rồi để AI chọn ra các video là PHIM/truyện phù hợp
// để cắt clip recap. Kênh không có nội dung phim (thể thao, tin tức...) thì báo không phù hợp.
import { extractJsonAfter } from './youtube-cookie.js'
import { languageBlock } from '../src/parse.js'
import { isChannelUrl } from '../src/youtube.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export { isChannelUrl }

// URL trang /videos của channel để lấy danh sách video
export function channelVideosUrl(url) {
  const u = new URL(String(url).trim())
  const base = u.origin + u.pathname.replace(/\/+$/, '').replace(/\/(videos|featured|streams|shorts|playlists)$/i, '')
  return base + '/videos'
}

// ===== Parse số lượt xem =====
// "156 lượt xem", "1,2 tr lượt xem", "12 N lượt xem", "1.2M views", "3.4K views"
export function parseViews(text) {
  const t = String(text || '').toLowerCase()
  const m = t.match(/([\d.,]+)\s*(tr|triệu|n\b|nghìn|ng|k|m|b|t\b|tỷ)?/)
  if (!m) return 0
  // số: bỏ dấu chấm ngăn nghìn (vi), đổi phẩy thập phân -> chấm
  let numStr = m[1]
  if (/,/.test(numStr)) numStr = numStr.replace(/\./g, '').replace(',', '.')
  else if ((numStr.match(/\./g) || []).length > 1) numStr = numStr.replace(/\./g, '')
  else if (/\.\d{3}$/.test(numStr)) numStr = numStr.replace(/\./g, '') // "1.234" kiểu vi = 1234
  const n = parseFloat(numStr) || 0
  const unit = m[2] || ''
  const mult =
    /tr|triệu|m/.test(unit) ? 1e6 :
    /n\b|nghìn|ng|k/.test(unit) ? 1e3 :
    /b|tỷ|t\b/.test(unit) ? 1e9 : 1
  return Math.round(n * mult)
}

// ===== Parse số tập từ tiêu đề (tập 5, episode 12, ep 3, tập 1-25 -> lấy số đầu) =====
export function parseEpisodeNumber(title) {
  const t = String(title || '').toLowerCase()
  const m = t.match(/(?:tập|tap|episode|ep|phần|phan|chương|chuong)\s*\.?\s*(\d{1,4})/)
  return m ? parseInt(m[1], 10) : Infinity
}

// ===== Parse "đăng cách đây bao lâu" -> số ngày (để xếp mới nhất) =====
export function parsePublishedDays(text) {
  const t = String(text || '').toLowerCase()
  const m = t.match(/(\d+)\s*(giờ|phút|ngày|tuần|tháng|năm|hour|minute|day|week|month|year)/)
  if (!m) return 1e9 // không rõ -> coi như rất cũ
  const n = parseInt(m[1], 10)
  const u = m[2]
  if (/năm|year/.test(u)) return n * 365
  if (/tháng|month/.test(u)) return n * 30
  if (/tuần|week/.test(u)) return n * 7
  if (/ngày|day/.test(u)) return n
  return 0 // giờ/phút -> hôm nay
}

// ===== Lấy video từ lockupViewModel trong ytInitialData / response browse =====
export function parseLockups(root) {
  const out = []
  const seen = new Set()
  const walk = (n, d = 0) => {
    if (!n || typeof n !== 'object' || d > 60) return
    if (Array.isArray(n)) { n.forEach(x => walk(x, d + 1)); return }
    if (n.lockupViewModel) {
      const lv = n.lockupViewModel
      const id = lv.contentId
      const meta = lv.metadata?.lockupMetadataViewModel
      const title = meta?.title?.content
      // chỉ lấy video thật (có id kiểu 11 ký tự), bỏ playlist/kênh
      if (id && /^[\w-]{11}$/.test(id) && title && !seen.has(id)) {
        seen.add(id)
        const parts = meta?.metadata?.contentMetadataViewModel?.metadataRows
          ?.flatMap(r => r.metadataParts || [])
          ?.map(p => p.text?.content)
          ?.filter(Boolean) || []
        const viewsText = parts.find(x => /xem|views|watching/i.test(x)) || ''
        const publishedText = parts.find(x => /trước|ago|trực tiếp|live/i.test(x)) || ''
        out.push({
          id,
          title,
          url: 'https://www.youtube.com/watch?v=' + id,
          viewsText,
          publishedText,
          views: parseViews(viewsText),
          daysAgo: parsePublishedDays(publishedText),
        })
      }
    }
    for (const v of Object.values(n)) walk(v, d + 1)
  }
  walk(root)
  return out
}

function findFirstKey(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 60) return null
  if (Array.isArray(node)) { for (const v of node) { const r = findFirstKey(v, key, depth + 1); if (r) return r } return null }
  if (key in node && node[key]) return node[key]
  for (const v of Object.values(node)) { const r = findFirstKey(v, key, depth + 1); if (r) return r }
  return null
}

const PUBLIC_INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'

// Lấy danh sách video của channel (nhiều trang qua continuation). Trả channelName + videos.
// Mặc định quét sâu (không chỉ vài trang đầu) để không bỏ sót phim cũ nằm sau trong danh sách —
// dừng khi hết continuation (kênh đã quét xong), chạm trần an toàn, hoặc quá ngân sách thời gian.
export async function fetchChannelVideos(url, { maxPages = 60, maxVideos = 2000, timeBudgetMs = 20000 } = {}) {
  const startedAt = Date.now()
  const pageUrl = channelVideosUrl(url)
  const html = await fetch(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8' } }).then(r => r.text())
  const data = extractJsonAfter(html, 'var ytInitialData = ')
  if (!data) throw new Error('Không đọc được dữ liệu channel (có thể link sai hoặc kênh riêng tư)')
  const cfg = extractJsonAfter(html, 'ytcfg.set(')
  const channelName = findFirstKey(data, 'channelMetadataRenderer')?.title
    || findFirstKey(data, 'pageHeaderRenderer')?.pageTitle
    || ''
  const videos = parseLockups(data)
  let cont = findFirstKey(data, 'continuationCommand')?.token
  const apiKey = cfg?.INNERTUBE_API_KEY || PUBLIC_INNERTUBE_KEY
  const clientVersion = cfg?.INNERTUBE_CLIENT_VERSION || '2.20240101.00.00'

  let pages = 1
  while (cont && pages < maxPages && videos.length < maxVideos && Date.now() - startedAt < timeBudgetMs) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/browse?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'vi', gl: 'VN' } }, continuation: cont }),
      })
      const j = await res.json()
      const more = parseLockups(j)
      if (!more.length) break
      for (const v of more) if (!videos.some(x => x.id === v.id)) videos.push(v)
      cont = findFirstKey(j, 'continuationCommand')?.token
      pages++
    } catch {
      break
    }
  }
  return { channelName: typeof channelName === 'string' ? channelName : '', videos }
}

// ===== Prompt do APP tự định nghĩa (không cho user sửa) =====
function buildSearchPrompt({ keyword, sortBy, language }) {
  const kw = String(keyword || '').trim()
  const episode = sortBy === 'episode'
  return [
    'Bạn là trợ lý chọn video PHIM để cắt clip recap đăng TikTok.',
    'Dưới đây là danh sách video công khai của một kênh YouTube (đã kèm lượt xem và thời gian đăng).',
    episode
      ? 'NHIỆM VỤ: chọn ra TẤT CẢ các TẬP PHIM (tiêu đề có "tập N" / "episode N" / "ep N" / "phần N"...) — sắp xếp theo thứ tự tập TĂNG DẦN từ tập đầu tới tập cuối. Lấy hết, đừng bỏ tập nào.'
      : 'NHIỆM VỤ: chọn ra TẤT CẢ video là PHIM / tập phim / truyện phim / phim chiếu mạng / review phim có nội dung kể chuyện. Đừng giới hạn số lượng, có bao nhiêu video phù hợp thì lấy hết.',
    kw ? ('CHỈ chọn video có TÊN PHIM liên quan tới: "' + kw + '" (bỏ qua phim khác).') : '',
    'LOẠI BỎ: video không phải phim (nhạc, vlog, tin tức, thể thao, gameshow, trailer ngắn, tổng hợp, livestream).',
    'Nếu kênh này KHÔNG có nội dung phù hợp thì trả về suitable=false, videos rỗng, và reason ngắn gọn.',
    'Giữ nguyên thứ tự như trong danh sách đưa vào (đã được sắp theo tiêu chí người dùng chọn).',
    'Chỉ trả về các url có trong danh sách, không bịa.',
    languageBlock(language),
  ].filter(Boolean).join('\n')
}

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    suitable: { type: 'boolean' },
    reason: { type: 'string' },
    videos: {
      type: 'array',
      items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' } }, required: ['url'] },
    },
  },
  required: ['suitable', 'videos'],
}

// Gọi Gemini chọn video (JSON). Retry khi model "high demand" (503) — giống analyzeVideo.
async function pickWithGemini({ apiKey, model, prompt, candidates }) {
  const list = candidates
    .map((v, i) => `${i + 1}. ${v.title} | ${v.views.toLocaleString('vi')} views | ${v.publishedText || '?'} | ${v.url}`)
    .join('\n')
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt + '\n\nDANH SÁCH VIDEO:\n' + list }] }],
    // Phim nhiều tập trả về hàng trăm url — nới trần output để JSON không bị cắt cụt giữa chừng
    generationConfig: { responseMimeType: 'application/json', responseSchema: SEARCH_SCHEMA, maxOutputTokens: 32768 },
  })
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1500 * attempt))
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    })
    if (res.ok) {
      const data = await res.json()
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
      try { return JSON.parse(text) } catch { return { suitable: false, reason: 'AI trả kết quả không đọc được', videos: [] } }
    }
    let detail = `HTTP ${res.status}`
    try { const b = await res.json(); if (b?.error?.message) detail = b.error.message } catch {}
    lastErr = new Error('Gemini từ chối: ' + detail)
    lastErr.status = res.status
    // 503/overload/quá tải: thử lại; lỗi khác: bỏ ngay
    if (!(res.status === 503 || /high demand|overloaded|unavailable/i.test(detail))) throw lastErr
  }
  throw lastErr
}

// So khớp từ khóa không dấu, không phân biệt hoa thường
// đ/Đ là chữ cái riêng của tiếng Việt (không phải "d" + dấu) nên NFD không tự tách được —
// phải đổi tay trước, không thì gõ "dau" sẽ không khớp "Đấu" (đúng kiểu lỗi lúc được lúc không).
const norm = s => String(s || '').toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')

// Chọn + sắp ứng viên đưa cho AI. Nếu khớp được từ khóa (vd tên phim cụ thể) thì KHÔNG cắt
// bớt — một phim dài 200+ tập vẫn phải gửi đủ hết, chỉ chặn ở một trần an toàn rất cao để
// tránh phình quá lớn khi khớp nhầm; không có/không khớp từ khóa thì giới hạn số ứng viên
// cho nhanh + đỡ tốn token vì lúc đó AI phải tự lọc theo nghĩa trên toàn bộ danh sách.
export function selectCandidates(videos, { sortBy = 'views', keyword = '' } = {}) {
  const kw = String(keyword || '').trim()
  let cand = videos
  let matchedByKeyword = false
  if (kw) {
    const nkw = norm(kw)
    const hit = videos.filter(v => norm(v.title).includes(nkw))
    if (hit.length) { cand = hit; matchedByKeyword = true }
  }
  const sortFn =
    sortBy === 'date' ? (a, b) => a.daysAgo - b.daysAgo :
    sortBy === 'episode' ? (a, b) => parseEpisodeNumber(a.title) - parseEpisodeNumber(b.title) || b.views - a.views :
    (a, b) => b.views - a.views
  cand = [...cand].sort(sortFn)
  const cap = matchedByKeyword ? 500 : 150
  return { candidates: cand.slice(0, cap), matchedByKeyword }
}

// Tìm kiếm clip từ 1 channel. sortBy: 'views' | 'date' | 'episode'. keyword: tùy chọn.
// Không giới hạn số lượng — trả về TẤT CẢ video phim phù hợp, user tự chọn dùng.
export async function searchChannel(url, { apiKey, model, sortBy = 'views', keyword = '', language } = {}) {
  if (!isChannelUrl(url)) throw new Error('Link không phải link channel hợp lệ (cần dạng youtube.com/channel/... hoặc /@...)')
  if (!apiKey) throw new Error('Chưa có Gemini API key — vào Cài đặt (⚙️) để nhập')
  // Có tên phim cụ thể cần tìm -> quét sâu hơn (phim cũ có thể nằm rất sau trong danh sách kênh)
  const scanOpts = keyword.trim()
    ? { maxPages: 150, maxVideos: 4500, timeBudgetMs: 28000 }
    : { maxPages: 40, maxVideos: 1200, timeBudgetMs: 15000 }
  const { channelName, videos } = await fetchChannelVideos(url, scanOpts)
  if (!videos.length) throw new Error('Không tìm thấy video công khai nào trong kênh này')

  const { candidates } = selectCandidates(videos, { sortBy, keyword })

  const prompt = buildSearchPrompt({ keyword, sortBy, language })
  const picked = await pickWithGemini({ apiKey, model, prompt, candidates })
  // chỉ giữ url thật sự có trong danh sách (không bịa), giữ đúng thứ tự AI trả
  const byUrl = new Map(videos.map(v => [v.url, v]))
  const idOf = u => { try { return new URL(u).searchParams.get('v') } catch { return null } }
  const seen = new Set()
  let results = (picked.videos || [])
    .map(x => byUrl.get(x.url) || videos.find(v => v.id === idOf(x.url)))
    .filter(v => v && !seen.has(v.id) && seen.add(v.id))
    .map(v => ({ url: v.url, title: v.title, views: v.views, publishedText: v.publishedText }))
  // Tiêu chí tập phim: đảm bảo thứ tự tập tăng dần dù AI trả lộn xộn
  if (sortBy === 'episode') results = results.sort((a, b) => parseEpisodeNumber(a.title) - parseEpisodeNumber(b.title))

  return {
    channelName,
    suitable: picked.suitable !== false && results.length > 0,
    reason: picked.reason || (results.length ? '' : 'Không tìm thấy video phù hợp'),
    totalScanned: videos.length,
    videos: results,
  }
}
