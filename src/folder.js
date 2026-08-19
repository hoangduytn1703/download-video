export function canPickFolder() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export async function pickDirectory() {
  if (!canPickFolder()) {
    throw new Error('Trình duyệt không hỗ trợ chọn thư mục. Dùng Chrome hoặc Edge.')
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  const perm = await handle.requestPermission({ mode: 'readwrite' })
  if (perm !== 'granted') throw new Error('Chưa được quyền ghi vào thư mục này')
  return handle
}

export async function writeStreamToFile(dirHandle, filename, response, onProgress, signal) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      await writable.write(value)
      if (total) onProgress?.(Math.min(99, (received / total) * 100), received, total)
      else onProgress?.(null, received, 0)
    }
    await writable.close()
  } catch (err) {
    try { await writable.abort() } catch {}
    throw err
  }
  onProgress?.(100, received, total)
  return received
}
