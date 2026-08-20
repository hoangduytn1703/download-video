// Đọc mốc thời gian các đoạn cắt từ text mà AI trên browser trả về.
// Hỗ trợ 3 định dạng:
// 1. Chuỗi pipe của team: Name: X | start_1: 00:46 | end_1: 02:46 | title_bottom_1: Y | start_2: ...
// 2. JSON: {name, segments:[{start,end,title}]} hoặc mảng [{start,end,title}]
// 3. Mỗi dòng một đoạn: "00:46 - 02:46 Tiêu đề" (chấp nhận -, –, —, ->, đến, to)

const TIME = /\d{1,3}:\d{1,2}(?::\d{1,2})?|\d{1,4}/
const isTime = v => /^\d{1,3}(:\d{1,2}){0,2}$/.test(String(v || '').trim())

function cleanTitle(s) {
  return String(s || '')
    .replace(/^[\s:\-–—.|)\]}>*#]+/, '') // ký tự thừa đầu chuỗi: ] ) * # - : ...
    .replace(/[\s|:\-–—([{<]+$/, '') // và cuối chuỗi
    .trim()
}

function fromJson(text) {
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  const list = Array.isArray(j) ? j : Array.isArray(j?.segments) ? j.segments : null
  if (!list) return null
  const segments = list
    .filter(s => isTime(s?.start) && isTime(s?.end))
    .map(s => ({ start: String(s.start).trim(), end: String(s.end).trim(), title: cleanTitle(s.title) }))
  return segments.length ? { name: cleanTitle(!Array.isArray(j) && j.name) || '', segments } : null
}

function fromPipeFormat(text) {
  const bucket = new Map() // n -> {start, end, title}
  const get = n => {
    if (!bucket.has(n)) bucket.set(n, {})
    return bucket.get(n)
  }
  for (const m of text.matchAll(/start[_\s]*(\d+)\s*[:=]\s*(\d{1,3}(?::\d{1,2}){0,2})/gi)) {
    get(Number(m[1])).start = m[2]
  }
  for (const m of text.matchAll(/end[_\s]*(\d+)\s*[:=]\s*(\d{1,3}(?::\d{1,2}){0,2})/gi)) {
    get(Number(m[1])).end = m[2]
  }
  // title_bottom_1 / title_1 / titulo_1... — lấy phần chữ tới trước dấu | hoặc hết dòng
  for (const m of text.matchAll(/title[a-z_\s]*?[_\s](\d+)\s*[:=]\s*([^|\n]+)/gi)) {
    get(Number(m[1])).title = cleanTitle(m[2])
  }
  const segments = [...bucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s)
    .filter(s => isTime(s.start) && isTime(s.end))
    .map(s => ({ start: s.start, end: s.end, title: s.title || '' }))
  if (!segments.length) return null
  const nameMatch = text.match(/name\s*[:=]\s*([^|\n]+)/i)
  return { name: cleanTitle(nameMatch?.[1]) || '', segments }
}

function fromLines(text) {
  const segments = []
  const re = new RegExp(
    `(${TIME.source})\\s*(?:-|–|—|->|→|to|đến|den|hasta)\\s*(${TIME.source})(.*)`,
    'i'
  )
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = line.match(re)
    if (!m || !isTime(m[1]) || !isTime(m[2])) continue
    // tiêu đề có thể đứng trước hoặc sau cặp mốc thời gian
    const before = cleanTitle(line.slice(0, m.index))
    const after = cleanTitle(m[3])
    segments.push({ start: m[1], end: m[2], title: after || before })
  }
  return segments.length ? { name: '', segments } : null
}

// Bảng markdown — AI hay trả kiểu này: | P1 | 00:46 | 02:46 | Tiêu đề |
function fromTable(text) {
  const segments = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if ((line.match(/\|/g) || []).length < 2) continue
    if (/^\|[\s:|-]+\|$/.test(line)) continue // dòng kẻ ngăn của bảng
    const cells = line.split('|').map(c => c.trim()).filter(Boolean)
    const timeIdx = []
    cells.forEach((c, i) => { if (isTime(c)) timeIdx.push(i) })
    if (timeIdx.length < 2) continue
    const [a, b] = timeIdx
    // tiêu đề: ô chữ dài nhất không phải mốc thời gian và không phải nhãn P1/P2
    const title = cells
      .filter((c, i) => i !== a && i !== b && !isTime(c) && !/^P?\d+[.)]?$/i.test(c))
      .sort((x, y) => y.length - x.length)[0]
    segments.push({ start: cells[a], end: cells[b], title: cleanTitle(title) })
  }
  return segments.length ? { name: '', segments } : null
}

export function parseSegmentsText(text) {
  const t = String(text || '').trim()
  if (!t) return { name: '', segments: [] }
  const result = fromJson(t) || fromPipeFormat(t) || fromTable(t) || fromLines(t)
  return result || { name: '', segments: [] }
}

// Prompt mẫu để copy đưa cho AI trên browser (Gemini/ChatGPT) — ra đúng định dạng app đọc được
export const BROWSER_AI_PROMPT = `Phân tích video này và trích xuất 3-5 đoạn hấp dẫn nhất từ đầu đến cuối video (số lượng tùy nội dung), bao gồm các sự kiện quan trọng mở đầu. Mỗi đoạn BẮT BUỘC dài từ 3 đến 5 phút, bỏ qua các phần không quan trọng giữa các đoạn. Ngôn ngữ của tên và tiêu đề theo ngôn ngữ nói trong video.

** QUY TẮC ĐỊNH DẠNG NGHIÊM NGẶT **:
Viết TẤT CẢ trên một dòng duy nhất, không thêm bất kỳ chữ nào khác.
Giữ đúng số thứ tự N (1, 2, 3...) cho các nhãn: start_N, end_N, title_bottom_N.
KHÔNG trộn số thứ tự với mốc thời gian (ĐÚNG: end_3: 12:42, SAI: end_12:42).

Cấu trúc chính xác:
Name: (tên video) | start_1: 0:10 | end_1: 3:15 | title_bottom_1: (tiêu đề P1) | start_2: 3:22 | end_2: 6:55 | title_bottom_2: (tiêu đề P2) | start_3: 8:02 | end_3: 12:42 | title_bottom_3: (tiêu đề P3)`
