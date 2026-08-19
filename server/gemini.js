import fs from 'fs'
import path from 'path'
import os from 'os'

// Cấu hình người dùng (API key, prompt) lưu ngoài repo — mỗi máy một file riêng
const CONFIG_DIR = path.join(os.homedir(), '.youtube-download-tool')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export const DEFAULT_PROMPT = `Trích xuất 3-5 đoạn video hấp dẫn nhất từ đầu đến cuối video (số lượng tùy nội dung), bao gồm các sự kiện quan trọng mở đầu. Mỗi đoạn BẮT BUỘC dài từ 3 đến 5 phút, bỏ qua các phần không quan trọng ở giữa các đoạn. Ngôn ngữ của name và title phải theo ngôn ngữ nói trong video. Đặt name là tiêu đề tổng ngắn gọn giật gân cho video, và title là tiêu đề hấp dẫn cho từng đoạn.`

export const DEFAULT_MODEL = 'gemini-2.5-flash'

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveConfig(patch) {
  const current = loadConfig()
  const next = { ...current, ...patch }
  // Không lưu giá trị rỗng đè lên key đã có
  for (const k of Object.keys(next)) {
    if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k]
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

// "mm:ss" | "h:mm:ss" | "ss" -> giây; trả null nếu không đọc được
export function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  const s = String(value || '').trim()
  if (!/^\d{1,3}(:\d{1,2}){0,2}$/.test(s)) return null
  const parts = s.split(':').map(Number)
  if (parts.slice(1).some(p => p > 59)) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

// giây -> "hh:mm:ss" cho ffmpeg
export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = n => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

// Chuẩn hóa segments từ Gemini/frontend: bỏ đoạn hỏng, ép start < end
export function normalizeSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) return []
  const out = []
  for (const seg of rawSegments) {
    const start = parseTimestamp(seg?.start)
    const end = parseTimestamp(seg?.end)
    if (start === null || end === null || end <= start) continue
    out.push({
      start,
      end,
      title: String(seg?.title || '').trim().slice(0, 200),
    })
  }
  return out
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Tiêu đề tổng ngắn gọn cho video' },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'STRING', description: 'Thời điểm bắt đầu, dạng mm:ss hoặc h:mm:ss' },
          end: { type: 'STRING', description: 'Thời điểm kết thúc, dạng mm:ss hoặc h:mm:ss' },
          title: { type: 'STRING', description: 'Tiêu đề cho đoạn này' },
        },
        required: ['start', 'end', 'title'],
      },
    },
  },
  required: ['name', 'segments'],
}

// Gọi Gemini phân tích video YouTube trực tiếp từ link (không cần tải video trước)
export async function analyzeVideo(url, { apiKey, prompt, model } = {}) {
  if (!apiKey) throw new Error('Chưa có Gemini API key — vào Cài đặt (⚙️) để nhập')
  const usedModel = model || DEFAULT_MODEL
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${usedModel}:generateContent`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000)
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{
          parts: [
            { fileData: { fileUri: url } },
            { text: prompt || DEFAULT_PROMPT },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Gemini phân tích quá lâu (hơn 5 phút) — thử lại hoặc dùng video ngắn hơn')
    throw new Error('Không gọi được Gemini API: ' + (err?.message || err))
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error?.message) detail = body.error.message
    } catch {}
    if (res.status === 400 && /API key/i.test(detail)) detail = 'API key không hợp lệ — kiểm tra lại trong Cài đặt (⚙️)'
    if (res.status === 429) detail = 'Hết quota Gemini tạm thời — chờ một lát rồi thử lại. ' + detail
    throw new Error('Gemini từ chối: ' + detail)
  }

  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Gemini trả về dữ liệu không đúng định dạng JSON')
  }
  const segments = normalizeSegments(parsed.segments)
  if (!segments.length) throw new Error('Gemini không tìm được đoạn hợp lệ nào trong video này')
  return { name: String(parsed.name || '').trim().slice(0, 150), segments }
}
