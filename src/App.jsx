import { useEffect, useRef, useState } from 'react'
import { getApiBase, runtime } from './api.js'
import { isYouTubeUrl } from './youtube.js'

export { isYouTubeUrl }

// Khi chạy bản build (GitHub Pages), gọi thẳng backend chạy trên máy người dùng
const API = getApiBase(runtime())

// Tạm ẩn nút "Tạm dừng tất cả" — đổi thành true khi muốn bật lại
const SHOW_PAUSE_ALL = false

let rowKey = 1
const newRow = (folder = '') => ({ key: rowKey++, url: '', filename: '', folder })

export default function App() {
  const [defaultFolder, setDefaultFolder] = useState('')
  const [rows, setRows] = useState([newRow()])
  const [jobs, setJobs] = useState([])
  const [concurrency, setConcurrency] = useState(3)
  const [view, setView] = useState('list')
  const [submitting, setSubmitting] = useState(false)
  const [paused, setPaused] = useState(false)
  // null = bình thường | 'running' = đang cập nhật (khóa màn hình) | {ok, message} = kết quả
  const [upd, setUpd] = useState(null)
  const pollRef = useRef(null)

  const refresh = async () => {
    const d = await fetch(`${API}/api/jobs`).then(r => r.json())
    setJobs(d.jobs)
    setPaused(!!d.paused)
    return d
  }

  useEffect(() => {
    fetch(`${API}/api/defaults`)
      .then(r => r.json())
      .then(d => {
        setDefaultFolder(d.folder)
        setRows(rs => rs.map(r => (r.folder ? r : { ...r, folder: d.folder })))
      })
    return () => clearInterval(pollRef.current)
  }, [])

  const hasRunning = jobs.some(j => j.status === 'queued' || j.status === 'downloading')
  const hasActive = jobs.some(j => j.status === 'downloading' || (j.status === 'queued' && !paused))
  const hasPausable = jobs.some(j => j.status === 'queued' || j.status === 'downloading' || j.status === 'paused')
  const has403 = jobs.some(j => j.status === 'error' && /403|forbidden/i.test(j.message))

  useEffect(() => {
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(refresh, 1000)
    }
    if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [hasRunning])

  // Cảnh báo khi reload / đóng tab lúc đang tải dở
  useEffect(() => {
    if (!hasRunning) return
    const warn = e => {
      e.preventDefault()
      e.returnValue = 'Video đang tải dở sẽ không được nối lại — phải tải lại từ đầu!'
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasRunning])

  const updateRow = (key, patch) =>
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))

  const removeRow = key => setRows(rs => rs.filter(r => r.key !== key))

  const addRow = () => setRows(rs => [...rs, newRow(defaultFolder)])

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
        // fill empty rows first, then append
        for (const r of filled) {
          if (!r.url && i < urls.length) r.url = urls[i++]
        }
        while (i < urls.length) filled.push({ ...newRow(defaultFolder), url: urls[i++] })
        return [...filled]
      })
    } catch {
      alert('Không đọc được clipboard')
    }
  }

  const pickFolder = async key => {
    const d = await fetch(`${API}/api/pick-folder`).then(r => r.json())
    if (d.folder) updateRow(key, { folder: d.folder })
  }

  const download = async () => {
    const items = rows.filter(r => isYouTubeUrl(r.url))
    if (!items.length) return
    setSubmitting(true)
    try {
      await fetch(`${API}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, concurrency }),
      })
      await refresh()
      // giữ lại các dòng link không hợp lệ để người dùng sửa
      const leftover = rows.filter(r => r.url.trim() && !isYouTubeUrl(r.url))
      setRows(leftover.length ? leftover : [newRow(defaultFolder)])
    } finally {
      setSubmitting(false)
    }
  }

  const clearFinished = async () => {
    await fetch(`${API}/api/jobs/clear-finished`, { method: 'POST' })
    await refresh()
  }

  const openFolder = id => fetch(`${API}/api/jobs/${id}/open`, { method: 'POST' })

  const cancelJob = async j => {
    const name = j.filename || j.url
    const ok = confirm(
      `Hủy tải "${name}"?\n\nVideo đang tải sẽ dừng ngay và file tạm sẽ bị dọn sạch khỏi máy. Muốn tải lại thì phải bắt đầu từ đầu đó nha!`
    )
    if (!ok) return
    await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE' })
    await refresh()
  }

  const pauseAll = async () => {
    await fetch(`${API}/api/pause`, { method: 'POST' })
    await refresh()
  }

  const resumeAll = async () => {
    await fetch(`${API}/api/resume`, { method: 'POST' })
    await refresh()
  }

  // Chạy `yt-dlp --update-to nightly`, khóa màn hình trong lúc chạy, xong tự thử lại job lỗi
  const updateYtdlp = async () => {
    setUpd('running')
    await fetch(`${API}/api/ytdlp/update`, { method: 'POST' })
    const timer = setInterval(async () => {
      const s = await fetch(`${API}/api/ytdlp/update`).then(r => r.json())
      if (s.updating) return
      clearInterval(timer)
      if (s.result?.ok) {
        await fetch(`${API}/api/jobs/retry-errors`, { method: 'POST' })
        await refresh()
      }
      setUpd(s.result || { ok: false, message: 'Không rõ kết quả cập nhật' })
    }, 1500)
  }

  return (
    <div className="app">
      <header className="hero">
        <h1><span className="logo">▶</span>Youtube<span className="grad">Download Tool</span></h1>
        <p className="hint">Dán link → đặt tên → chọn folder → nhấn tải, xong! 🚀</p>
      </header>

      {hasRunning && !paused && (
        <div className="warning-banner">
          <span className="warning-icon">⚡</span>
          <span>
            Đang tải dở đó nha! Đừng vội đóng hay F5 trang — video đang chạy sẽ <b>không được nối lại</b>, phải tải lại từ đầu. Ráng chờ xíu, sắp xong rồi ☕
          </span>
        </div>
      )}

      {has403 && !upd && (
        <div className="error-banner">
          <span className="warning-icon">🛡️</span>
          <span>
            YouTube vừa đổi cơ chế chặn nên một số video bị lỗi <b>403</b>. Đừng lo — bấm nút bên cạnh để cập nhật bộ tải về bản mới nhất, xong app sẽ tự thử lại các video lỗi cho bạn.
          </span>
          <button className="btn-reset" onClick={updateYtdlp}>🔄 Reset bộ tải</button>
        </div>
      )}

      {upd !== null && (
        <div className="overlay">
          <div className="overlay-card">
            {upd === 'running' ? (
              <>
                <div className="spinner" />
                <h3>Đang cập nhật bộ tải...</h3>
                <p>Chờ xíu nha, thường chỉ mất 15–30 giây. Đừng tắt trang trong lúc này!</p>
              </>
            ) : upd.ok ? (
              <>
                <div className="overlay-emoji">🎉</div>
                <h3>Cập nhật xong!</h3>
                <p>{upd.message}</p>
                <p>Các video bị lỗi đã được đưa vào hàng chờ tải lại.</p>
                <button className="primary" onClick={() => setUpd(null)}>OK, ngon rồi</button>
              </>
            ) : (
              <>
                <div className="overlay-emoji">😵</div>
                <h3>Cập nhật thất bại</h3>
                <p>{upd.message}</p>
                <p>Thử lại lần nữa, hoặc chạy tay lệnh <code>yt-dlp --update-to nightly</code> trong terminal.</p>
                <button className="primary" onClick={() => setUpd(null)}>Đóng</button>
              </>
            )}
          </div>
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
                value={r.folder}
                onChange={e => updateRow(r.key, { folder: e.target.value })}
              />
              <button className="btn-icon" title="Chọn thư mục" onClick={() => pickFolder(r.key)}>📁</button>
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
              {SHOW_PAUSE_ALL && hasPausable && (
                paused || !hasActive ? (
                  <button className="btn-resume" onClick={resumeAll}>▶ Tiếp tục tất cả</button>
                ) : (
                  <button className="btn-pause" onClick={pauseAll}>⏸ Tạm dừng tất cả</button>
                )
              )}
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
                  {j.status === 'paused' && '⏸ Tạm dừng'}
                  {j.status === 'done' && '✅ Xong'}
                  {j.status === 'error' && '❌ Lỗi'}
                </span>
                <span className="job-url" title={j.url}>{j.filename || j.url}</span>
                {j.status === 'done' && (
                  <button className="btn-icon btn-open" title="Mở thư mục chứa file" onClick={() => openFolder(j.id)}>📂</button>
                )}
                {(j.status === 'queued' || j.status === 'downloading' || j.status === 'paused') && (
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
