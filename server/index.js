import express from 'express'
import { spawn, execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { collectSpawnOutput, sendJsonOnce } from './http-utils.js'
import { loadConfig, saveConfig, analyzeVideo, listModels, normalizeSegments, formatTimestamp, DEFAULT_PROMPT, DEFAULT_MODEL } from './gemini.js'
import { fetchTranscript } from './transcript.js'
import { analyzeViaYoutubeAsk, NO_ASK_MESSAGE } from './youtube-ask.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3001
let maxConcurrent = 3
// Tran chay song song: che do Cat cho phep toi 10 link mot lan
const MAX_CONCURRENT_LIMIT = 10

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
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type')
    // Chrome chặn trang HTTPS public gọi vào localhost nếu thiếu header này (Private Network Access)
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

function resolveCommand(name) {
  const fromEnv = process.env[`${name.replace(/-/g, '_').toUpperCase()}_PATH`]
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const dirs = [
    path.join(__dirname, '..', 'resources', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
  ]
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const dir of dirs) {
    for (const filename of names) {
      const candidate = path.join(dir, filename)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(finder, [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    if (out && fs.existsSync(out)) return out
  } catch {}
  return name
}

const YTDLP = resolveCommand('yt-dlp')
const FFMPEG = process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)
  ? process.env.FFMPEG_PATH
  : null
// ffmpeg gọi trực tiếp khi cắt clip (khác với --ffmpeg-location đưa cho yt-dlp)
const FFMPEG_BIN = FFMPEG || resolveCommand('ffmpeg')

// Tham số dùng chung cho mọi lệnh yt-dlp: trỏ ffmpeg đóng gói kèm (nếu có) và
// dùng POT server khi máy có cài — yt-dlp nightly hiện tự lấy được 1080p nên POT chỉ là dự phòng.
function commonArgs() {
  const args = ['--no-playlist']
  if (FFMPEG) args.push('--ffmpeg-location', FFMPEG)
  if (fs.existsSync(potServerScript)) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`)
  }
  return args
}

// Môi trường cho tiến trình yt-dlp: UTF-8 để tên file tiếng Việt không lỗi font
function ytdlpEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PATH: `${path.join(os.homedir(), '.local', 'bin')}${path.delimiter}${process.env.PATH || ''}`,
  }
}

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
// Đếm job đang chạy THEO LOẠI: job cắt luôn chạy song song hết cỡ (trần 10),
// job tải thường theo selectbox — hai bên không giành slot của nhau.
const activeByType = { download: 0, cut: 0 }
const typeOf = job => (job.type === 'cut' ? 'cut' : 'download')
const capOf = job => (job.type === 'cut' ? MAX_CONCURRENT_LIMIT : maxConcurrent)
const takeSlot = job => { activeByType[typeOf(job)]++ }
const freeSlot = job => { activeByType[typeOf(job)] = Math.max(0, activeByType[typeOf(job)] - 1) }
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
  if (c >= 1 && c <= MAX_CONCURRENT_LIMIT) maxConcurrent = c
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
  if (typeof global.__electronRevealFolder === 'function') {
    global.__electronRevealFolder(folder, file)
    return
  }
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
  // Trong app desktop: dùng hộp thoại native của Electron (luôn nổi đúng trên cửa sổ app).
  // Chạy dạng web: rơi về dialog của hệ điều hành qua PowerShell/osascript/zenity.
  if (typeof global.__electronFolderPicker === 'function') {
    try {
      return sendJsonOnce(res, { folder: await global.__electronFolderPicker() })
    } catch {
      return sendJsonOnce(res, { folder: null })
    }
  }
  const folder = await collectSpawnOutput(spawnFolderPicker())
  sendJsonOnce(res, { folder })
})


// ===== Cắt clip theo phân tích AI (Gemini) =====

app.get('/api/settings', (req, res) => {
  const cfg = loadConfig()
  res.json({
    hasGeminiKey: Boolean(cfg.geminiKey),
    prompt: cfg.prompt || '',
    appendFormatRules: cfg.appendFormatRules !== false, // mặc định bật
    model: cfg.model || DEFAULT_MODEL,
    speedMode: cfg.speedMode === 'quality' ? 'quality' : 'fast',
    language: cfg.language || 'Tây Ban Nha',
  })
})

app.post('/api/settings', (req, res) => {
  const patch = {}
  if (typeof req.body?.geminiKey === 'string' && req.body.geminiKey.trim()) patch.geminiKey = req.body.geminiKey.trim()
  if (typeof req.body?.prompt === 'string') patch.prompt = req.body.prompt.trim()
  if (typeof req.body?.model === 'string' && req.body.model.trim()) patch.model = req.body.model.trim()
  if (typeof req.body?.appendFormatRules === 'boolean') patch.appendFormatRules = req.body.appendFormatRules
  if (req.body?.speedMode === 'fast' || req.body?.speedMode === 'quality') patch.speedMode = req.body.speedMode
  if (typeof req.body?.language === 'string' && req.body.language.trim()) patch.language = req.body.language.trim().slice(0, 40)
  const cfg = saveConfig(patch)
  res.json({
    ok: true,
    hasGeminiKey: Boolean(cfg.geminiKey),
    prompt: cfg.prompt || '',
    appendFormatRules: cfg.appendFormatRules !== false,
    model: cfg.model || DEFAULT_MODEL,
    speedMode: cfg.speedMode === 'quality' ? 'quality' : 'fast',
    language: cfg.language || 'Tây Ban Nha',
  })
})

// ===== Tự cập nhật app (chỉ có khi chạy trong app desktop bản cài đặt) =====
const noUpdater = { supported: false, state: 'idle', currentVersion: '', autoCheck: false }

app.get('/api/app-update', (req, res) => {
  const u = global.__electronAppUpdate
  res.json(u ? u.getState() : noUpdater)
})

app.post('/api/app-update/:action', (req, res) => {
  const u = global.__electronAppUpdate
  if (!u) return res.status(400).json({ ok: false, message: 'Chỉ dùng được trong app desktop' })
  const { action } = req.params
  if (action === 'check') u.check()
  else if (action === 'download') u.download()
  else if (action === 'install') u.install()
  else if (action === 'auto') u.setAutoCheck(req.body?.enabled)
  else return res.status(404).json({ ok: false, message: 'Hành động không hợp lệ' })
  res.json({ ok: true, ...u.getState() })
})

// Danh sách model Gemini khả dụng cho key đang lưu — để dropdown không bao giờ lỗi thời
app.get('/api/models', async (req, res) => {
  try {
    const models = await listModels(loadConfig().geminiKey)
    res.json({ ok: true, models })
  } catch (err) {
    res.status(422).json({ ok: false, message: err?.message || String(err) })
  }
})

// Gemini phân tích: mặc định dùng phụ đề (nhanh). source=youtube thì điều khiển Hỏi AI trên YouTube.
app.post('/api/analyze', async (req, res) => {
  const url = (req.body?.url || '').trim()
  if (!isYouTubeUrl(url)) return res.status(400).json({ ok: false, message: 'Link YouTube không hợp lệ' })
  const cfg = loadConfig()
  try {
    const source = req.body?.source
    if (source === 'youtube' || source === 'browser') {
      try {
        const result = await analyzeViaYoutubeAsk(url, { prompt: cfg.prompt, language: cfg.language })
        return res.json({ ok: true, ...result })
      } catch (err) {
        if ((err?.message || '') !== NO_ASK_MESSAGE) throw err
        console.warn('[analyze] YouTube Ask missing, falling back to transcript')
      }
    }
    let transcript = null
    try {
      transcript = await fetchTranscript(url, YTDLP)
    } catch (err) {
      console.warn('[analyze] transcript failed, falling back to video:', err?.message || err)
    }
    // Tab Cắt có thể gửi prompt riêng cho lần cắt đó (không đụng prompt lưu trong Cài đặt)
    const promptOverride = typeof req.body?.prompt === 'string' && req.body.prompt.trim() ? req.body.prompt.trim() : null
    const base = { apiKey: cfg.geminiKey, prompt: promptOverride || cfg.prompt, transcript, language: cfg.language }
    // Chế độ Nhanh (mặc định): có phụ đề thì phân tích bằng model lite (~1-3s thay vì ~25s).
    // Lite lỗi hoặc trả kết quả rỗng thì tự chạy lại bằng model chính — không hỏng luồng.
    const useFast = transcript && cfg.speedMode !== 'quality'
    let result
    if (useFast) {
      try {
        result = await analyzeVideo(url, { ...base, model: cfg.fastModel || 'gemini-flash-lite-latest' })
      } catch (err) {
        console.warn('[analyze] fast model failed, retrying with main model:', err?.message || err)
      }
    }
    if (!result) {
      result = await analyzeVideo(url, { ...base, model: cfg.model })
    }
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(422).json({ ok: false, message: err?.message || String(err) })
  }
})

// Tạo job cắt: tải video gốc rồi cắt thành nhiều clip theo segments
app.post('/api/cut-jobs', (req, res) => {
  const c = parseInt(req.body?.concurrency, 10)
  if (c >= 1 && c <= MAX_CONCURRENT_LIMIT) maxConcurrent = c
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  const created = []
  for (const it of items) {
    const url = (it.url || '').trim()
    const segments = normalizeSegments(it.segments)
    if (!url || !isYouTubeUrl(url) || !segments.length) continue
    const id = String(nextId++)
    const job = {
      id,
      type: 'cut',
      url,
      filename: sanitizeFilename(it.filename || '') || `video-${id}`,
      folder: (it.folder || '').trim() || defaultFolder,
      segments,
      status: 'queued',
      progress: 0,
      message: `Chờ tải + cắt ${segments.length} clip...`,
    }
    jobs.set(id, job)
    queue.push(job)
    created.push(job)
  }
  pump()
  res.json({ jobs: created })
})

function pump() {
  if (paused) return
  for (let i = 0; i < queue.length; ) {
    const job = queue[i]
    if (activeByType[typeOf(job)] < capOf(job)) {
      queue.splice(i, 1)
      runJob(job)
    } else {
      i++
    }
  }
}

function runJob(job) {
  takeSlot(job)
  job.status = 'downloading'
  job.message = 'Đang bắt đầu...'

  try {
    fs.mkdirSync(job.folder, { recursive: true })
  } catch (e) {
    finish(job, 'error', 'Không tạo được thư mục: ' + e.message)
    return
  }

  // Nhớ lại video đã nằm sẵn trong thư mục từ trước hay chưa — nếu có thì sau khi
  // cắt xong KHÔNG xóa, vì đó là file của người dùng chứ không phải job này tải về
  if (job.type === 'cut') job.preExisting = Boolean(findDownloadedFile(job.folder, job.filename))

  const outTemplate = path.join(job.folder, (job.filename || '%(title)s') + '.%(ext)s')
  const args = [
    '--newline',
    ...commonArgs(),
    '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
    job.url,
  ]

  const proc = spawn(YTDLP, args, { env: ytdlpEnv() })
  procs.set(job.id, proc)
  let lastError = ''

  // Gom theo dòng: chunk stdout có thể cắt ngang dòng (hoặc ngang ký tự UTF-8 tiếng Việt),
  // parse thẳng từng chunk sẽ bắt hụt dòng Destination/Merger.
  let stdoutTail = ''
  const handleLine = line => {
    const pct = line.match(/\[download\]\s+([\d.]+)%/)
    if (pct) {
      const raw = parseFloat(pct[1])
      job.progress = job.type === 'cut' ? Math.round(raw * 0.7) : raw
      job.message = line.trim()
      return
    }
    const dest =
      line.match(/\[download\] Destination: (.+)/) ||
      line.match(/\[Merger\] Merging formats into "(.+)"/) ||
      line.match(/\[download\] (.+) has already been downloaded/)
    if (dest) {
      job.filepath = dest[1].trim()
      job.message = 'File: ' + path.basename(job.filepath)
    }
  }

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', chunk => {
    const text = stdoutTail + chunk
    const lines = text.split(/\r?\n/)
    stdoutTail = lines.pop() ?? '' // phần cuối có thể là dòng dở
    for (const line of lines) handleLine(line)
    // dòng progress không có newline (bị \r ghi đè) nên vẫn xử lý phần đuôi
    if (stdoutTail) handleLine(stdoutTail)
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
      freeSlot(job)
      pump()
      return
    }
    if (job.pausing) {
      delete job.pausing
      job.status = 'paused'
      job.message = 'Đã tạm dừng — sẽ tải tiếp từ chỗ này'
      freeSlot(job)
      return
    }
    if (job.status === 'error') return
    if (code === 0) {
      if (job.type === 'cut') {
        cutSegments(job)
        return
      }
      job.progress = 100
      finish(job, 'done', job.message || 'Hoàn tất')
    } else {
      finish(job, 'error', lastError || `yt-dlp thoát với mã lỗi ${code}`)
    }
  })
}


// Cắt video gốc thành các clip theo segments — dùng -c copy nên gần như tức thì
// Dò file vừa tải trong thư mục theo tên gốc — dùng khi không đọc được đường dẫn
// từ output yt-dlp (ví dụ video đã tải sẵn từ trước nên không có dòng Destination)
const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.flv']
function findDownloadedFile(folder, base) {
  let files
  try {
    files = fs.readdirSync(folder)
  } catch {
    return null
  }
  for (const ext of VIDEO_EXTS) {
    if (files.includes(base + ext)) return path.join(folder, base + ext)
  }
  // bỏ qua các mảnh rời .f399.mp4 / .f251.webm và file tải dở .part
  const match = files.find(
    f =>
      f.startsWith(base + '.') &&
      VIDEO_EXTS.includes(path.extname(f).toLowerCase()) &&
      !/\.f\d+\.[^.]+$/i.test(f)
  )
  return match ? path.join(folder, match) : null
}

async function cutSegments(job) {
  job.status = 'cutting'
  let input = job.filepath && fs.existsSync(job.filepath) ? job.filepath : null
  if (!input) input = findDownloadedFile(job.folder, job.filename)
  if (!input) {
    return finish(job, 'error', `Không tìm thấy file video gốc trong ${job.folder} (tên bắt đầu bằng "${job.filename}")`)
  }
  job.filepath = input
  const base = path.basename(input).replace(/\.[^.]+$/, '')
  const total = job.segments.length
  const made = []

  for (let i = 0; i < total; i++) {
    if (job.canceled) break
    const seg = job.segments[i]
    job.message = `Đang cắt clip ${i + 1}/${total}: ${seg.title || ''}`
    const outPath = path.join(job.folder, `${base}_P${i + 1}.mp4`)
    const code = await runFfmpegCut(job, input, seg, outPath)
    if (job.canceled) break
    if (code !== 0) {
      try { fs.rmSync(outPath, { force: true }) } catch {}
      return finish(job, 'error', `Cắt clip ${i + 1}/${total} thất bại (ffmpeg mã ${code}) — video gốc vẫn giữ tại ${input}`)
    }
    made.push(outPath)
    job.progress = 70 + Math.round(((i + 1) / total) * 30)
  }

  if (job.canceled) {
    cleanupCutOutputs(job, input, base)
    jobs.delete(job.id)
    freeSlot(job)
    pump()
    return
  }

  const titles = job.segments
    .map((s, i) => `P${i + 1} (${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}): ${s.title}`)
    .join('\r\n')
  try { fs.writeFileSync(path.join(job.folder, `${base}_titles.txt`), titles, 'utf8') } catch {}
  // Xóa video gốc do job này tải về (sản phẩm là các clip). File đã có sẵn từ trước
  // thì giữ nguyên — đó là file của người dùng.
  if (!job.preExisting) {
    try { fs.rmSync(input, { force: true }) } catch {}
  }
  job.filepath = made[0]
  job.progress = 100
  const kept = job.preExisting ? ' (video gốc giữ nguyên)' : ''
  finish(job, 'done', `Đã cắt ${made.length} clip (${base}_P1…P${made.length}) + ${base}_titles.txt${kept}`)
}

function runFfmpegCut(job, input, seg, outPath) {
  return new Promise(resolve => {
    const args = [
      '-y',
      '-ss', formatTimestamp(seg.start),
      '-to', formatTimestamp(seg.end),
      '-i', input,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      outPath,
    ]
    const proc = spawn(FFMPEG_BIN, args, { stdio: 'ignore' })
    procs.set(job.id, proc)
    proc.on('error', () => { procs.delete(job.id); resolve(-1) })
    proc.on('close', code => { procs.delete(job.id); resolve(code) })
  })
}

// Dọn khi hủy job cắt giữa chừng: xóa video gốc + các clip đã cắt dở
function cleanupCutOutputs(job, input, base) {
  setTimeout(() => {
    try {
      for (const f of fs.readdirSync(job.folder)) {
        const isOriginal = f === path.basename(input) && !job.preExisting
        const isOutput = (f.startsWith(base + '_P') && f.endsWith('.mp4')) || f === `${base}_titles.txt` || isOriginal
        if (isOutput) { try { fs.rmSync(path.join(job.folder, f), { force: true }) } catch {} }
      }
    } catch {}
  }, 700)
}

function finish(job, status, message) {
  job.status = status
  job.message = message
  freeSlot(job)
  pump()
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ytdlp: YTDLP !== 'yt-dlp' })
})

// Stream the video to the browser. The browser writes it to the user's folder
// (File System Access API), so files always land on the visitor's machine.
app.post('/api/stream', (req, res) => {
  const url = (req.body?.url || '').trim()
  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({ ok: false, message: 'Link YouTube không hợp lệ' })
  }
  const filename = `${sanitizeFilename(req.body?.filename || 'video') || 'video'}.mp4`

  const args = [
    '--newline',
    ...commonArgs(),
    '-f', 'best[height<=1080][ext=mp4]/best[height<=1080]/best',
    '--no-part',
    '-o', '-',
    url,
  ]
  const proc = spawn(YTDLP, args, { env: ytdlpEnv() })

  let started = false
  let lastError = ''
  const begin = () => {
    if (started || res.headersSent) return
    started = true
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  }

  proc.stdout.on('data', chunk => {
    begin()
    res.write(chunk)
  })
  proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim()
    if (text.startsWith('ERROR')) lastError = text
  })
  proc.on('error', err => {
    if (!started && !res.headersSent) {
      sendJsonOnce(res.status(500), { ok: false, message: 'Không chạy được yt-dlp: ' + err.message })
      return
    }
    if (!res.writableEnded) res.end()
  })
  proc.on('close', code => {
    if (!started && !res.headersSent) {
      sendJsonOnce(res.status(500), { ok: false, message: lastError || `yt-dlp thoát với mã lỗi ${code}` })
      return
    }
    if (!res.writableEnded) res.end()
  })
  req.on('close', () => killProcTree(proc))
})

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
