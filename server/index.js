import express from 'express'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { collectSpawnOutput, sendJsonOnce } from './http-utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 3001
let maxConcurrent = 3

const app = express()
app.use(express.json())

// Keep the local helper alive: one bad request must not kill Vite via concurrently -k
process.on('uncaughtException', err => {
  console.error('[server] uncaughtException — keeping process alive:', err)
})
process.on('unhandledRejection', err => {
  console.error('[server] unhandledRejection — keeping process alive:', err)
})

function isAllowedOrigin(origin) {
  if (!origin) return false
  if (origin === 'https://hoangduytn1703.github.io') return true
  return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
}

// Cho phép trang GitHub Pages (và Vite dev) gọi API trên máy này.
// Chỉ whitelist origin cụ thể — không mở '*' để web lạ không điều khiển được downloader.
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    // Chrome chặn trang HTTPS public gọi vào localhost nếu thiếu header này (Private Network Access)
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

function resolveCommand(name) {
  const dirs = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin']
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const dir of dirs) {
    for (const filename of names) {
      const candidate = path.join(dir, filename)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return name
}

const YTDLP = resolveCommand('yt-dlp')

function spawnSafe(command, args, options) {
  const proc = spawn(command, args, options)
  proc.on('error', err => {
    console.warn(`[server] spawn ${command} failed:`, err.message)
  })
  return proc
}

function killProcTree(proc) {
  if (!proc?.pid) return
  if (process.platform === 'win32') {
    spawnSafe('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }
  try { proc.kill('SIGTERM') } catch {}
}

// In-memory only — restart the server and everything is gone
const jobs = new Map()
const procs = new Map() // tiến trình yt-dlp đang chạy, để riêng vì job được serialize ra JSON
let nextId = 1
const queue = []
let active = 0
let paused = false
let updating = false
let updateResult = null

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

function isYouTubeUrl(url) {
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return false
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.length > 1
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      return (
        (u.pathname === '/watch' && u.searchParams.has('v')) ||
        u.pathname.startsWith('/shorts/') ||
        u.pathname.startsWith('/live/')
      )
    }
    return false
  } catch {
    return false
  }
}

app.get('/api/defaults', (req, res) => {
  res.json({ folder: defaultFolder })
})

app.post('/api/jobs', (req, res) => {
  const c = parseInt(req.body.concurrency, 10)
  if (c >= 1 && c <= 5) maxConcurrent = c
  const items = Array.isArray(req.body.items) ? req.body.items : []
  const created = []
  for (const it of items) {
    const url = (it.url || '').trim()
    if (!url || !isYouTubeUrl(url)) continue
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
  res.json({ jobs: [...jobs.values()], paused, updating })
})

// Tạm dừng tất cả: dừng yt-dlp nhưng GIỮ file .part — khi tiếp tục, yt-dlp tự nối tiếp
app.post('/api/pause', (req, res) => {
  paused = true
  for (const [id, proc] of procs) {
    const job = jobs.get(id)
    if (job) job.pausing = true
    killProcTree(proc)
  }
  res.json({ ok: true })
})

app.post('/api/resume', (req, res) => {
  paused = false
  for (const job of jobs.values()) {
    if (job.status === 'paused') {
      job.status = 'queued'
      job.message = 'Chờ tải tiếp...'
      queue.push(job)
    }
  }
  pump()
  res.json({ ok: true })
})

// Thử lại toàn bộ job lỗi (dùng sau khi cập nhật yt-dlp)
app.post('/api/jobs/retry-errors', (req, res) => {
  let count = 0
  for (const job of jobs.values()) {
    if (job.status === 'error') {
      job.status = 'queued'
      job.progress = 0
      job.message = ''
      delete job.filepath
      queue.push(job)
      count++
    }
  }
  pump()
  res.json({ ok: true, count })
})

// Cập nhật yt-dlp lên kênh nightly — dùng khi YouTube đổi cơ chế chặn (lỗi 403)
app.post('/api/ytdlp/update', (req, res) => {
  if (updating) return res.json({ ok: true, already: true })
  updating = true
  updateResult = null
  const proc = spawnSafe(YTDLP, ['--update-to', 'nightly'])
  let out = ''
  proc.stdout.on('data', d => { out += d.toString() })
  proc.stderr.on('data', d => { out += d.toString() })
  proc.on('close', code => {
    updating = false
    const lines = out.trim().split(/\r?\n/).filter(Boolean)
    updateResult = { ok: code === 0, message: lines[lines.length - 1] || `yt-dlp thoát với mã ${code}` }
  })
  proc.on('error', err => {
    updating = false
    updateResult = { ok: false, message: 'Không chạy được yt-dlp: ' + err.message }
  })
  res.json({ ok: true })
})

app.get('/api/ytdlp/update', (req, res) => {
  res.json({ updating, result: updateResult })
})

app.post('/api/jobs/clear-finished', (req, res) => {
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'error') jobs.delete(id)
  }
  res.json({ ok: true })
})

// Hủy job đang chờ hoặc đang tải: dừng yt-dlp và dọn file tạm
app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ ok: false })
  if (job.status === 'done' || job.status === 'error') {
    return res.status(400).json({ ok: false, message: 'Job đã kết thúc, không hủy được' })
  }
  if (job.status === 'queued' || job.status === 'paused') {
    const i = queue.indexOf(job)
    if (i >= 0) queue.splice(i, 1)
    jobs.delete(job.id)
    cleanupPartialFiles(job) // job paused có thể còn file .part
    return res.json({ ok: true })
  }
  // đang tải: đánh dấu rồi kill cả cây tiến trình (yt-dlp + ffmpeg con)
  job.canceled = true
  const proc = procs.get(job.id)
  if (proc) killProcTree(proc)
  res.json({ ok: true })
})

// Xóa file tạm của job bị hủy (.part, .ytdl, các mảnh .fXXX và file merge dở)
function cleanupPartialFiles(job) {
  const base = job.filename ||
    (job.filepath ? path.basename(job.filepath).replace(/(\.f\d+)?\.[^.]+$/, '') : null)
  if (!base) return
  // chờ chút cho Windows nhả file lock sau khi kill tiến trình
  setTimeout(() => {
    let files = []
    try { files = fs.readdirSync(job.folder) } catch { return }
    for (const f of files) {
      if (!f.startsWith(base + '.')) continue
      const isTemp = /\.(part|ytdl|temp)$/i.test(f) || /\.f\d+\.\w+(\.part)?$/i.test(f) || f === base + '.mp4'
      if (isTemp) {
        try { fs.rmSync(path.join(job.folder, f), { force: true }) } catch {}
      }
    }
  }, 700)
}

// Mở Explorer tại thư mục của job, chọn sẵn file nếu còn tồn tại
app.post('/api/jobs/:id/open', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ ok: false })
  const file = job.filepath && fs.existsSync(job.filepath) ? job.filepath : ''
  openInExplorer(job.folder, file)
  res.json({ ok: true })
})

function openInExplorer(folder, file) {
  const target = file || folder
  if (process.platform === 'win32') {
    openInWindowsExplorer(folder, file)
    return
  }
  spawnSafe(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

// Mở Explorer rồi đẩy cửa sổ lên trước — tiến trình nền không được Windows cho cướp focus,
// nên phải dùng SetWindowPos (topmost rồi bỏ topmost) để cửa sổ không chìm sau browser.
// Đường dẫn truyền qua env var để khỏi lo escape ký tự đặc biệt/tiếng Việt.
function openInWindowsExplorer(folder, file) {
  const script = `
$folder = $env:OPEN_FOLDER
$file = $env:OPEN_FILE
if ($file) { Start-Process explorer.exe -ArgumentList ('/select,"' + $file + '"') }
else { Start-Process explorer.exe -ArgumentList ('"' + $folder + '"') }
Start-Sleep -Milliseconds 1000
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hAfter, int x, int y, int cx, int cy, uint uFlags);' -Name Win -Namespace Native
$shell = New-Object -ComObject Shell.Application
$wins = @($shell.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $folder } catch { $false } })
if (-not $wins.Count) { $wins = @($shell.Windows()) }
if ($wins.Count) {
  $hwnd = [IntPtr]$wins[$wins.Count - 1].HWND
  [Native.Win]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x43) | Out-Null
  [Native.Win]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x43) | Out-Null
}`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  spawnSafe('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OPEN_FOLDER: folder, OPEN_FILE: file },
  }).unref()
}

function spawnFolderPicker() {
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Chon thu muc tai ve'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }`
    return spawnSafe('powershell', ['-NoProfile', '-STA', '-Command', script])
  }
  if (process.platform === 'darwin') {
    return spawnSafe('osascript', ['-e', 'POSIX path of (choose folder)'])
  }
  return spawnSafe('zenity', ['--file-selection', '--directory', '--title=Chon thu muc tai ve'])
}

app.get('/api/pick-folder', async (req, res) => {
  const folder = await collectSpawnOutput(spawnFolderPicker())
  sendJsonOnce(res, { folder })
})

function pump() {
  while (!paused && active < maxConcurrent && queue.length) {
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

  const proc = spawn(YTDLP, args, {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PATH: `${path.join(os.homedir(), '.local', 'bin')}${path.delimiter}${process.env.PATH || ''}`,
    },
  })
  procs.set(job.id, proc)
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
      if (dest) {
        job.filepath = dest[1].trim()
        job.message = 'File: ' + path.basename(job.filepath)
      }
    }
  })

  proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim()
    if (text.startsWith('ERROR')) lastError = text
  })

  proc.on('error', err => finish(job, 'error', 'Không chạy được yt-dlp: ' + err.message))

  proc.on('close', code => {
    procs.delete(job.id)
    if (job.canceled) {
      cleanupPartialFiles(job)
      jobs.delete(job.id)
      active--
      pump()
      return
    }
    if (job.pausing) {
      delete job.pausing
      job.status = 'paused'
      job.message = 'Đã tạm dừng — sẽ tải tiếp từ chỗ này'
      active--
      return
    }
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
  if (YTDLP === 'yt-dlp') {
    console.warn('Không tìm thấy yt-dlp trong PATH — tải video sẽ lỗi ENOENT')
  } else {
    console.log(`yt-dlp: ${YTDLP}`)
  }
})
