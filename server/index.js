import express from 'express'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 3001
const MAX_CONCURRENT = 2

const app = express()
app.use(express.json())

// Cho phép trang GitHub Pages (và Vite dev) gọi API trên máy này.
// Chỉ whitelist origin cụ thể — không mở '*' để web lạ không điều khiển được downloader.
const ALLOWED_ORIGINS = ['https://hoangduytn1703.github.io', 'http://localhost:5173']
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// In-memory only — restart the server and everything is gone
const jobs = new Map()
let nextId = 1
const queue = []
let active = 0

const defaultFolder = path.join(os.homedir(), 'Downloads')

// bgutil POT server — sinh PO token để YouTube không chặn format 1080p (403)
const POT_BASE_URL = 'http://localhost:4416'
const potServerScript = path.join(os.homedir(), 'bgutil-ytdlp-pot-provider', 'server', 'build', 'main.js')
if (fs.existsSync(potServerScript)) {
  const pot = spawn('node', [potServerScript], { stdio: 'ignore' })
  pot.on('error', () => console.warn('Không khởi động được POT server'))
  pot.unref()
  process.on('exit', () => { try { pot.kill() } catch {} })
} else {
  console.warn('Không tìm thấy bgutil POT server — video 1080p có thể bị YouTube chặn (403)')
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '').trim()
}

app.get('/api/defaults', (req, res) => {
  res.json({ folder: defaultFolder })
})

app.post('/api/jobs', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : []
  const created = []
  for (const it of items) {
    const url = (it.url || '').trim()
    if (!url) continue
    const id = String(nextId++)
    const job = {
      id,
      url,
      filename: sanitizeFilename(it.filename || ''),
      folder: (it.folder || '').trim() || defaultFolder,
      status: 'queued', // queued | downloading | done | error
      progress: 0,
      message: '',
    }
    jobs.set(id, job)
    queue.push(job)
    created.push(job)
  }
  pump()
  res.json({ jobs: created })
})

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: [...jobs.values()] })
})

app.post('/api/jobs/clear-finished', (req, res) => {
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'error') jobs.delete(id)
  }
  res.json({ ok: true })
})

// Native Windows folder picker (dialog opens on the server machine — fine for a local app)
app.get('/api/pick-folder', (req, res) => {
  const script = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Chon thu muc tai ve'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }`
  const ps = spawn('powershell', ['-NoProfile', '-STA', '-Command', script])
  let out = ''
  ps.stdout.on('data', d => { out += d.toString() })
  ps.on('close', () => res.json({ folder: out.trim() || null }))
  ps.on('error', () => res.json({ folder: null }))
})

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    runJob(queue.shift())
  }
}

function runJob(job) {
  active++
  job.status = 'downloading'
  job.message = 'Đang bắt đầu...'

  try {
    fs.mkdirSync(job.folder, { recursive: true })
  } catch (e) {
    finish(job, 'error', 'Không tạo được thư mục: ' + e.message)
    return
  }

  const outTemplate = path.join(job.folder, (job.filename || '%(title)s') + '.%(ext)s')
  const args = [
    '--newline',
    '--no-playlist',
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`,
    '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
    job.url,
  ]

  const proc = spawn('yt-dlp', args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  let lastError = ''

  proc.stdout.on('data', chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const pct = line.match(/\[download\]\s+([\d.]+)%/)
      if (pct) {
        job.progress = parseFloat(pct[1])
        job.message = line.trim()
        continue
      }
      const dest = line.match(/\[download\] Destination: (.+)/) || line.match(/\[Merger\] Merging formats into "(.+)"/)
      if (dest) job.message = 'File: ' + path.basename(dest[1])
    }
  })

  proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim()
    if (text.startsWith('ERROR')) lastError = text
  })

  proc.on('error', err => finish(job, 'error', 'Không chạy được yt-dlp: ' + err.message))

  proc.on('close', code => {
    if (job.status === 'error') return
    if (code === 0) {
      job.progress = 100
      finish(job, 'done', job.message || 'Hoàn tất')
    } else {
      finish(job, 'error', lastError || `yt-dlp thoát với mã lỗi ${code}`)
    }
  })
}

function finish(job, status, message) {
  job.status = status
  job.message = message
  active--
  pump()
}

// Optional: serve the built frontend with `npm run start`
if (process.argv.includes('--serve-dist')) {
  const dist = path.join(__dirname, '..', 'dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.listen(PORT, () => {
  console.log(`API server chạy tại http://localhost:${PORT}`)
})
