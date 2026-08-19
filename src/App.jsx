import { useEffect, useRef, useState } from 'react'
import { canPickFolder, pickDirectory } from './folder.js'
import { downloadVideo } from './download.js'
import { isYouTubeUrl } from './youtube.js'

export { isYouTubeUrl }

let rowKey = 1
const newRow = () => ({ key: rowKey++, url: '', filename: '' })

let jobSeq = 1

export default function App() {
  const [rows, setRows] = useState([newRow()])
  const [jobs, setJobs] = useState([])
  const [concurrency, setConcurrency] = useState(3)
  const [view, setView] = useState('list')
  const [submitting, setSubmitting] = useState(false)
  const [folderLabel, setFolderLabel] = useState('')
  const [folderError, setFolderError] = useState('')
  const dirHandleRef = useRef(null)
  const controllers = useRef(new Map())
  const activeRef = useRef(0)
  const queueRef = useRef([])
  const concurrencyRef = useRef(concurrency)

  useEffect(() => {
    concurrencyRef.current = concurrency
  }, [concurrency])

  const patchJob = (id, patch) =>
    setJobs(list => list.map(j => (j.id === id ? { ...j, ...patch } : j)))

  const pump = () => {
    while (activeRef.current < concurrencyRef.current && queueRef.current.length) {
      const job = queueRef.current.shift()
      runJob(job)
    }
  }

  const runJob = async job => {
    activeRef.current++
    const ac = new AbortController()
    controllers.current.set(job.id, ac)
    patchJob(job.id, { status: 'downloading', message: 'Đang tải về máy bạn...' })
    try {
      const result = await downloadVideo({
        url: job.url,
        filename: job.filename,
        dirHandle: dirHandleRef.current,
        signal: ac.signal,
        onProgress: (pct, received) => {
          if (pct == null) {
            const mb = (received / 1048576).toFixed(1)
            patchJob(job.id, { message: `Đã nhận ${mb} MB` })
            return
          }
          patchJob(job.id, { progress: pct, message: `Đang ghi file ${Math.floor(pct)}%` })
        },
      })
      patchJob(job.id, {
        status: 'done',
        progress: 100,
        message: 'Đã lưu trên máy bạn',
        filename: result.name,
        folder: result.folder,
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        setJobs(list => list.filter(j => j.id !== job.id))
      } else {
        patchJob(job.id, {
          status: 'error',
          message: err?.message || 'Tải thất bại',
        })
      }
    } finally {
      controllers.current.delete(job.id)
      activeRef.current--
      pump()
    }
  }

  const updateRow = (key, patch) =>
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))

  const removeRow = key => setRows(rs => rs.filter(r => r.key !== key))

  const addRow = () => setRows(rs => [...rs, newRow()])

  const pasteLinks = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const found = text.split(/[\s,]+/).filter(s => /^https?:\/\//.test(s))
      const urls = found.filter(isYouTubeUrl)
      if (!urls.length) {
        if (found.length) alert('Clipboard toàn link lạ — chỉ nhận link YouTube thôi nha!')
        return
      }
      setRows(rs => {
        const filled = [...rs]
        let i = 0
        for (const r of filled) {
          if (!r.url && i < urls.length) r.url = urls[i++]
        }
        while (i < urls.length) filled.push({ ...newRow(), url: urls[i++] })
        return [...filled]
      })
    } catch {
      alert('Không đọc được clipboard')
    }
  }

  const pickFolder = async () => {
    setFolderError('')
    try {
      const handle = await pickDirectory()
      dirHandleRef.current = handle
      setFolderLabel(handle.name)
    } catch (err) {
      if (err?.name === 'AbortError') return
      setFolderError(err?.message || 'Không chọn được thư mục')
    }
  }

  const download = async () => {
    const items = rows.filter(r => isYouTubeUrl(r.url))
    if (!items.length) return
    if (!dirHandleRef.current && canPickFolder()) {
      try {
        const handle = await pickDirectory()
        dirHandleRef.current = handle
        setFolderLabel(handle.name)
      } catch (err) {
        if (err?.name === 'AbortError') return
        setFolderError(err?.message || 'Hãy chọn thư mục lưu trên máy bạn')
        return
      }
    }
    setSubmitting(true)
    const created = items.map(it => ({
      id: String(jobSeq++),
      url: it.url.trim(),
      filename: it.filename,
      folder: folderLabel || 'Downloads (trình duyệt)',
      status: 'queued',
      progress: 0,
      message: 'Chờ tải...',
    }))
    setJobs(list => [...created, ...list])
    queueRef.current.push(...created)
    const leftover = rows.filter(r => r.url.trim() && !isYouTubeUrl(r.url))
    setRows(leftover.length ? leftover : [newRow()])
    setSubmitting(false)
    pump()
  }

  const clearFinished = () =>
    setJobs(list => list.filter(j => j.status !== 'done' && j.status !== 'error'))

  const cancelJob = async j => {
    const name = j.filename || j.url
    const ok = confirm(
      `Hủy tải "${name}"?\n\nVideo đang tải sẽ dừng ngay. Muốn tải lại thì phải bắt đầu từ đầu đó nha!`,
    )
    if (!ok) return
    controllers.current.get(j.id)?.abort()
    queueRef.current = queueRef.current.filter(q => q.id !== j.id)
    setJobs(list => list.filter(job => job.id !== j.id))
  }

  const hasRunning = jobs.some(j => j.status === 'queued' || j.status === 'downloading')

  useEffect(() => {
    if (!hasRunning) return
    const warn = e => {
      e.preventDefault()
      e.returnValue = 'Video đang tải dở sẽ không được nối lại — phải tải lại từ đầu!'
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasRunning])

  return (
    <div className="app">
      <header className="hero">
        <h1><span className="logo">▶</span>Youtube<span className="grad">Download Tool</span></h1>
        <p className="hint">Dán link → đặt tên → chọn folder trên máy bạn → nhấn tải 🚀</p>
      </header>

      {hasRunning && (
        <div className="warning-banner">
          <span className="warning-icon">⚡</span>
          <span>
            Đang tải dở đó nha! Đừng vội đóng hay F5 trang — file đang ghi sẽ <b>không được nối lại</b>.
          </span>
        </div>
      )}

      {folderError && (
        <div className="error-banner">
          <span className="warning-icon">📁</span>
          <span>{folderError}</span>
        </div>
      )}

      <div className="card">
        <div className="rows">
          {rows.map((r, i) => {
            const urlInvalid = r.url.trim() !== '' && !isYouTubeUrl(r.url)
            return (
            <div className="row-wrap" key={r.key}>
            <div className="row">
              <span className="row-num">{i + 1}</span>
              <input
                className={`url${urlInvalid ? ' invalid' : ''}`}
                placeholder="https://www.youtube.com/watch?v=..."
                value={r.url}
                onChange={e => updateRow(r.key, { url: e.target.value })}
              />
              <input
                className="filename"
                placeholder="Tên file (tùy chọn)"
                value={r.filename}
                onChange={e => updateRow(r.key, { filename: e.target.value })}
              />
              <input
                className="folder"
                placeholder="Thư mục tải về"
                value={folderLabel}
                readOnly
                onClick={pickFolder}
              />
              <button className="btn-icon" title="Chọn thư mục trên máy bạn" onClick={pickFolder}>📁</button>
              <button
                className="btn-icon"
                title="Xóa dòng"
                onClick={() => removeRow(r.key)}
                disabled={rows.length === 1}
              >✕</button>
            </div>
            {urlInvalid && (
              <div className="row-error">⚠ Link không hợp lệ — chỉ nhận link YouTube (youtube.com / youtu.be) thôi nha</div>
            )}
            </div>
          )})}
        </div>

        <div className="actions">
          <button onClick={addRow}>＋ Thêm link</button>
          <button onClick={pasteLinks}>📋 Dán nhiều link</button>
          <label className="concurrency">
            Tải cùng lúc
            <select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} video</option>)}
            </select>
          </label>
          <button className="primary" onClick={download} disabled={submitting || !rows.some(r => isYouTubeUrl(r.url))}>
            ⬇ Tải xuống ({rows.filter(r => isYouTubeUrl(r.url)).length})
          </button>
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="jobs">
          <div className="jobs-header">
            <h2>Tiến trình</h2>
            <div className="jobs-tools">
              <div className="view-toggle">
                <button
                  className={view === 'list' ? 'active' : ''}
                  title="Xem dạng danh sách"
                  onClick={() => setView('list')}
                >☰</button>
                <button
                  className={view === 'grid' ? 'active' : ''}
                  title="Xem dạng lưới"
                  onClick={() => setView('grid')}
                >▦</button>
              </div>
              <button onClick={clearFinished}>🧹 Dọn mục đã xong</button>
            </div>
          </div>
          <div className={`job-list ${view}`}>
          {jobs.map(j => (
            <div className={`job job-${j.status}`} key={j.id}>
              <div className="job-top">
                <span className="job-status">
                  {j.status === 'queued' && '⏳ Chờ'}
                  {j.status === 'downloading' && '⚡ Đang tải'}
                  {j.status === 'done' && '✅ Xong'}
                  {j.status === 'error' && '❌ Lỗi'}
                </span>
                <span className="job-url" title={j.url}>{j.filename || j.url}</span>
                {(j.status === 'queued' || j.status === 'downloading') && (
                  <button className="btn-icon btn-cancel" title="Hủy tải video này" onClick={() => cancelJob(j)}>🗑</button>
                )}
                <span className="job-pct">{j.status === 'done' ? '100%' : `${Math.floor(j.progress)}%`}</span>
              </div>
              <div className="bar"><div className="bar-fill" style={{ width: `${j.progress}%` }} /></div>
              <div className="job-msg">{j.message} <span className="job-folder">→ {j.folder}</span></div>
            </div>
          ))}
          </div>
        </div>
      )}

      <footer className="footer">© 2026 - code by Nguyễn Hoàng Duy</footer>
    </div>
  )
}
