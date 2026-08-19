const { app, BrowserWindow, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { pathToFileURL } = require('url')

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

  await import(pathToFileURL(path.join(projectRoot, 'server', 'index.js')).href)
  return port
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
