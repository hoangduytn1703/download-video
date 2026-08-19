import { apiUrl, runtime } from './api.js'
import { suggestedFilename } from './youtube.js'
import { writeStreamToFile } from './folder.js'

function filenameFromDisposition(header, fallback) {
  if (!header) return fallback
  const star = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (star) return decodeURIComponent(star[1])
  const plain = header.match(/filename="?([^";]+)"?/i)
  return plain ? plain[1] : fallback
}

function saveBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

async function streamFromApi(url, filename, signal) {
  let res
  try {
    res = await fetch(apiUrl('/api/stream', runtime()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename: filename || 'video' }),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new Error('Không kết nối được bộ tải. Chạy npm start rồi mở đúng địa chỉ app (không dùng GitHub Pages cho bước tải).')
  }
  const type = res.headers.get('content-type') || ''
  if (!res.ok || type.includes('application/json')) {
    let message = `Không tải được (${res.status})`
    try {
      const err = await res.json()
      if (err.message) message = err.message
    } catch {}
    if (res.status === 404) {
      message = 'Trang tĩnh (GitHub Pages) không tải được video. Mở http://localhost:3001 sau khi chạy npm start — file vẫn lưu trên máy bạn.'
    }
    throw new Error(message)
  }
  return res
}

export async function downloadVideo({ url, filename, dirHandle, onProgress, signal }) {
  const fallbackName = suggestedFilename(filename, 'video')
  const res = await streamFromApi(url, filename, signal)
  const name = filenameFromDisposition(res.headers.get('content-disposition'), fallbackName)
  if (dirHandle) {
    await writeStreamToFile(dirHandle, name, res, onProgress, signal)
    return { name, folder: dirHandle.name }
  }
  const blob = await res.blob()
  onProgress?.(100)
  saveBlob(blob, name)
  return { name, folder: 'Downloads (trình duyệt)' }
}
