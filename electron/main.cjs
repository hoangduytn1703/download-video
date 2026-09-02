const { app, BrowserWindow, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const os = require('os')
const { pathToFileURL } = require('url')
const { autoUpdater } = require('electron-updater')

// Chỉ cho phép một cửa sổ app chạy tại một thời điểm
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const projectRoot = path.join(__dirname, '..')
// Khi đóng gói, binary nằm trong resources/bin (extraResources); khi dev thì lấy từ repo
const binDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(projectRoot, 'resources', 'bin')

const exe = name => {
  const p = path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name)
  return fs.existsSync(p) ? p : null
}

let mainWindow = null

// Tìm cổng trống bắt đầu từ `start` — tránh đụng khi máy đã chạy sẵn npm run dev
function findFreePort(start, attemptsLeft = 20) {
  return new Promise((resolve, reject) => {
    if (attemptsLeft <= 0) return reject(new Error('Không tìm được cổng trống'))
    const srv = net.createServer()
    srv.once('error', () => {
      findFreePort(start + 1, attemptsLeft - 1).then(resolve, reject)
    })
    // Bind giống hệt cách server thật bind (mọi interface), nếu không sẽ báo trống nhầm
    srv.listen(start, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function startBackend() {
  const port = await findFreePort(3001)
  process.env.PORT = String(port)

  const ytdlp = exe('yt-dlp')
  const ffmpeg = exe('ffmpeg')
  if (ytdlp) process.env.YT_DLP_PATH = ytdlp
  if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg

  // Hộp thoại chọn thư mục của Electron: native, luôn nổi đúng trên cửa sổ app.
  // Server gọi hook này thay cho PowerShell khi chạy trong app desktop.
  global.__electronFolderPicker = async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn thư mục tải về',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  }

  // Mở thư mục trong file explorer bằng API của Electron — không cần PowerShell
  global.__electronRevealFolder = (folder, file) => {
    if (file && fs.existsSync(file)) shell.showItemInFolder(file)
    else shell.openPath(folder)
  }

  // Tải một trang web bằng cửa sổ ẩn rồi trả HTML sau khi JS chạy xong (dùng cho TikTok:
  // fetch() thuần bị tường lửa chặn, chỉ Chromium thật mới qua). Dùng chính Chromium của app —
  // không tốn thêm dung lượng. Session riêng để cookie TikTok không lẫn với cửa sổ chính.
  global.__electronFetchPage = (url, { timeoutMs = 30000, settleMs = 1500 } = {}) => new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:tiktok' },
    })
    let finished = false
    const done = (err, html) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { win.destroy() } catch {}
      err ? reject(err) : resolve(html)
    }
    const timer = setTimeout(() => done(new Error('Trang không tải xong sau ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs)
    // Bỏ dấu vết Electron/tên app trong User-Agent — trông như Chrome thường
    const ua = win.webContents.getUserAgent().replace(/\s\S+\/[\d.]+\s(?=Chrome\/)/, ' ').replace(/\sElectron\/[\d.]+/, '')
    win.webContents.setUserAgent(ua)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('did-fail-load', (_e, code, desc) => { if (code !== -3) done(new Error(desc || ('Lỗi tải trang ' + code))) })
    win.webContents.on('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, settleMs)) // chờ trang hydrate xong
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true)
        done(null, String(html || ''))
      } catch (e) {
        done(e)
      }
    })
    win.loadURL(url).catch(e => done(e))
  })

  setupAutoUpdate()

  await import(pathToFileURL(path.join(projectRoot, 'server', 'index.js')).href)
  return port
}

// ===== Tự cập nhật app từ GitHub Releases =====
// Chỉ chạy được ở bản cài đặt (Setup). Bản portable giải nén ra thư mục tạm
// mỗi lần chạy nên không thể tự ghi đè chính nó.
const configFile = path.join(os.homedir(), '.youtube-download-tool', 'config.json')

function readAutoCheck() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    return cfg.autoCheckUpdate !== false // mặc định bật
  } catch {
    return true
  }
}

function writeAutoCheck(enabled) {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch {}
  cfg.autoCheckUpdate = Boolean(enabled)
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8')
  } catch {}
}

// Lỗi thô của electron-updater rất dài (kèm cả header HTTP) — rút gọn cho dễ đọc
function friendlyUpdateError(err) {
  const raw = String(err?.message || err || '')
  if (/Unable to find latest version|No published versions/i.test(raw)) {
    return 'Chưa có bản phát hành chính thức nào trên GitHub (bản đang có để nhãn Pre-release thì không tính).'
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network/i.test(raw)) {
    return 'Không kết nối được mạng để kiểm tra bản mới.'
  }
  if (/404/.test(raw)) return 'Không tìm thấy file cập nhật trong bản phát hành trên GitHub.'
  if (/sha512|checksum/i.test(raw)) return 'File tải về không khớp mã kiểm tra — thử lại giúp nhé.'
  return raw.split('\n')[0].slice(0, 160)
}

// state: idle | checking | available | not-available | downloading | downloaded | error
const updateState = {
  supported: false,
  currentVersion: app.getVersion(),
  state: 'idle',
  newVersion: '',
  notes: '',
  percent: 0,
  error: '',
  autoCheck: readAutoCheck(),
}

function setupAutoUpdate() {
  // Bản portable đặt biến này; bản chạy dev thì chưa đóng gói
  const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
  updateState.supported = app.isPackaged && !isPortable

  global.__electronAppUpdate = {
    getState: () => ({ ...updateState }),
    check: () => {
      if (!updateState.supported) return
      updateState.state = 'checking'
      updateState.error = ''
      autoUpdater.checkForUpdates().catch(err => {
        updateState.state = 'error'
        updateState.error = friendlyUpdateError(err)
      })
    },
    download: () => {
      if (!updateState.supported || updateState.state !== 'available') return
      updateState.state = 'downloading'
      updateState.percent = 0
      autoUpdater.downloadUpdate().catch(err => {
        updateState.state = 'error'
        updateState.error = friendlyUpdateError(err)
      })
    },
    install: () => {
      if (updateState.state !== 'downloaded') return
      setImmediate(() => autoUpdater.quitAndInstall(false, true))
    },
    setAutoCheck: enabled => {
      updateState.autoCheck = Boolean(enabled)
      writeAutoCheck(enabled)
    },
  }

  if (!updateState.supported) return

  autoUpdater.autoDownload = false // người dùng bấm nút mới tải
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', info => {
    updateState.state = 'available'
    updateState.newVersion = info?.version || ''
    updateState.notes = typeof info?.releaseNotes === 'string' ? info.releaseNotes.slice(0, 800) : ''
  })
  autoUpdater.on('update-not-available', () => { updateState.state = 'not-available' })
  autoUpdater.on('download-progress', p => {
    updateState.state = 'downloading'
    updateState.percent = Math.round(p?.percent || 0)
  })
  autoUpdater.on('update-downloaded', () => {
    updateState.state = 'downloaded'
    updateState.percent = 100
  })
  autoUpdater.on('error', err => {
    updateState.state = 'error'
    updateState.error = friendlyUpdateError(err)
  })

  if (updateState.autoCheck) {
    // chờ cửa sổ hiện xong rồi mới kiểm tra, tránh làm chậm lúc khởi động
    setTimeout(() => global.__electronAppUpdate.check(), 4000)
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12101f',
    show: false,
    title: 'Youtube Download Tool',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  mainWindow.setMenuBarVisibility(false)
  // Truyền địa chỉ backend qua query để frontend biết gọi đúng cổng
  mainWindow.loadFile(path.join(projectRoot, 'dist-app', 'index.html'), {
    search: `?api=${encodeURIComponent(`http://localhost:${port}`)}`,
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Link ngoài mở bằng trình duyệt mặc định, không mở trong cửa sổ app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  try {
    const port = await startBackend()
    createWindow(port)
  } catch (err) {
    dialog.showErrorBox('Không khởi động được app', String(err?.stack || err))
    app.quit()
  }
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => app.quit())
