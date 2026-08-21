import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

const PREFER_LANGS = ['vi', 'es', 'en']
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

function videoIdFromUrl(url) {
  try {
    const u = new URL(url.trim())
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] || null
    return u.searchParams.get('v')
  } catch {
    return null
  }
}

export function pickCaptionTrack(tracks, prefer = PREFER_LANGS) {
  if (!Array.isArray(tracks) || !tracks.length) return null
  for (const lang of prefer) {
    const hit = tracks.find(t => t.languageCode === lang || t.languageCode?.startsWith(lang + '-'))
    if (hit) return hit
  }
  return tracks[0]
}

export function parseJson3(data) {
  const events = data?.events
  if (!Array.isArray(events)) return []
  const cues = []
  for (const ev of events) {
    const raw = (ev.segs || []).map(s => s.utf8 || '').join('')
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) continue
    cues.push({ start: Math.max(0, (ev.tStartMs || 0) / 1000), text })
  }
  return cues
}

function vttToSec(stamp) {
  const parts = stamp.replace(',', '.').split(':').map(Number)
  if (parts.some(n => Number.isNaN(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

export function parseVtt(text) {
  const cues = []
  const blocks = String(text || '').replace(/\r/g, '').split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l && l !== 'WEBVTT' && !l.startsWith('NOTE') && !/^\d+$/.test(l))
    const time = lines.find(l => l.includes('-->'))
    if (!time) continue
    const startRaw = time.split('-->')[0].trim()
    const spoken = lines.filter(l => l !== time).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!spoken) continue
    cues.push({ start: vttToSec(startRaw), text: spoken })
  }
  return cues
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function formatTranscript(cues) {
  return cues.map(c => `[${fmtTime(c.start)}] ${c.text}`).join('\n')
}

function sliceJsonValue(source, start) {
  const pair = { '{': '}', '[': ']' }
  const open = source[start]
  if (!pair[open]) return null
  const stack = [pair[open]]
  let inStr = false
  let escape = false
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(pair[ch])
      continue
    }
    if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null
      if (!stack.length) return source.slice(start, i + 1)
    }
  }
  return null
}

export function extractCaptionTracks(html) {
  const key = '"captionTracks"'
  const keyAt = html.indexOf(key)
  if (keyAt < 0) return []
  const start = html.indexOf('[', keyAt)
  if (start < 0) return []
  const raw = sliceJsonValue(html, start)
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function fetchTranscriptFromPage(url) {
  const id = videoIdFromUrl(url)
  if (!id) throw new Error('Link YouTube không hợp lệ')
  const watch = `https://www.youtube.com/watch?v=${id}`
  const html = await fetch(watch, { headers: { 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8' } }).then(r => {
    if (!r.ok) throw new Error('Không mở được trang YouTube (HTTP ' + r.status + ')')
    return r.text()
  })
  const track = pickCaptionTrack(extractCaptionTracks(html))
  if (!track?.baseUrl) throw new Error('Video này không có phụ đề — không phân tích nhanh được')
  const sep = track.baseUrl.includes('?') ? '&' : '?'
  const capRes = await fetch(track.baseUrl + sep + 'fmt=json3', { headers: { 'User-Agent': UA } })
  const raw = await capRes.text()
  if (!capRes.ok || !raw.trim()) throw new Error('Không tải được phụ đề trực tiếp')
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('Phụ đề không đúng JSON')
  }
  const cues = parseJson3(data)
  if (!cues.length) throw new Error('Phụ đề trống')
  return formatTranscript(cues)
}

function runYtdlpSubs(ytdlpBin, url, dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlpBin, [
      '--skip-download',
      '--write-auto-subs',
      '--sub-langs', 'vi,en,es',
      '--sub-format', 'json3',
      '--no-warnings',
      '-P', dir,
      '-o', '%(id)s',
      url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('error', e => reject(new Error('Không chạy được yt-dlp: ' + e.message)))
    proc.on('close', () => resolve(err))
  })
}

function cuesFromCaptionFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  if (filePath.endsWith('.json3')) {
    try {
      return parseJson3(JSON.parse(raw))
    } catch {
      return []
    }
  }
  return parseVtt(raw)
}

async function fetchTranscriptViaYtdlp(url, ytdlpBin) {
  if (!ytdlpBin) throw new Error('Chưa có yt-dlp')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcap-'))
  try {
    await runYtdlpSubs(ytdlpBin, url, dir)
    const files = fs.readdirSync(dir).filter(f => /\.(json3|vtt)$/i.test(f))
    if (!files.length) throw new Error('yt-dlp không tải được phụ đề')
    const rank = f => {
      const n = f.toLowerCase()
      if (n.includes('.vi.')) return 0
      if (n.includes('.es.')) return 1
      if (n.includes('.en')) return 2
      return 3
    }
    files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    const cues = cuesFromCaptionFile(path.join(dir, files[0]))
    if (!cues.length) throw new Error('Phụ đề trống')
    return formatTranscript(cues)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

export async function fetchTranscript(url, ytdlpBin) {
  try {
    return await fetchTranscriptFromPage(url)
  } catch {
    return fetchTranscriptViaYtdlp(url, ytdlpBin)
  }
}
