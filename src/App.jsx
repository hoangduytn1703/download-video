import { useEffect, useRef, useState } from 'react'

let rowKey = 1
const newRow = (folder = '') => ({ key: rowKey++, url: '', filename: '', folder })

export default function App() {
  const [defaultFolder, setDefaultFolder] = useState('')
  const [rows, setRows] = useState([newRow()])
  const [jobs, setJobs] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const pollRef = useRef(null)

  useEffect(() => {
    fetch('/api/defaults')
      .then(r => r.json())
      .then(d => {
        setDefaultFolder(d.folder)
        setRows(rs => rs.map(r => (r.folder ? r : { ...r, folder: d.folder })))
      })
    return () => clearInterval(pollRef.current)
  }, [])

  const hasRunning = jobs.some(j => j.status === 'queued' || j.status === 'downloading')

  useEffect(() => {
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const d = await fetch('/api/jobs').then(r => r.json())
        setJobs(d.jobs)
      }, 1000)
    }
    if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [hasRunning])

  const updateRow = (key, patch) =>
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))

  const removeRow = key => setRows(rs => rs.filter(r => r.key !== key))

  const addRow = () => setRows(rs => [...rs, newRow(defaultFolder)])

  const pasteLinks = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const urls = text.split(/[\s,]+/).filter(s => /^https?:\/\//.test(s))
      if (!urls.length) return
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
    const d = await fetch('/api/pick-folder').then(r => r.json())
    if (d.folder) updateRow(key, { folder: d.folder })
  }

  const download = async () => {
    const items = rows.filter(r => r.url.trim())
    if (!items.length) return
    setSubmitting(true)
    try {
      await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const d = await fetch('/api/jobs').then(r => r.json())
      setJobs(d.jobs)
      setRows([newRow(defaultFolder)])
    } finally {
      setSubmitting(false)
    }
  }

  const clearFinished = async () => {
    await fetch('/api/jobs/clear-finished', { method: 'POST' })
    const d = await fetch('/api/jobs').then(r => r.json())
    setJobs(d.jobs)
  }

  return (
    <div className="app">
      <h1>🎬 YouTube Downloader</h1>
      <p className="hint">Dán link YouTube, đặt tên file (bỏ trống = lấy tên video), chọn thư mục cho từng link. Chất lượng mặc định 1080p.</p>

      <div className="rows">
        {rows.map((r, i) => (
          <div className="row" key={r.key}>
            <span className="row-num">{i + 1}</span>
            <input
              className="url"
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
        ))}
      </div>

      <div className="actions">
        <button onClick={addRow}>＋ Thêm link</button>
        <button onClick={pasteLinks}>📋 Dán nhiều link</button>
        <button className="primary" onClick={download} disabled={submitting || !rows.some(r => r.url.trim())}>
          ⬇ Tải xuống ({rows.filter(r => r.url.trim()).length})
        </button>
      </div>

      {jobs.length > 0 && (
        <div className="jobs">
          <div className="jobs-header">
            <h2>Tiến trình</h2>
            <button onClick={clearFinished} disabled={hasRunning && jobs.every(j => j.status !== 'done' && j.status !== 'error')}>
              Xóa mục đã xong
            </button>
          </div>
          {jobs.map(j => (
            <div className={`job job-${j.status}`} key={j.id}>
              <div className="job-top">
                <span className="job-status">
                  {j.status === 'queued' && '⏳ Chờ'}
                  {j.status === 'downloading' && '⬇ Đang tải'}
                  {j.status === 'done' && '✅ Xong'}
                  {j.status === 'error' && '❌ Lỗi'}
                </span>
                <span className="job-url" title={j.url}>{j.filename || j.url}</span>
                <span className="job-pct">{j.status === 'done' ? '100%' : `${Math.floor(j.progress)}%`}</span>
              </div>
              <div className="bar"><div className="bar-fill" style={{ width: `${j.progress}%` }} /></div>
              <div className="job-msg">{j.message} <span className="job-folder">→ {j.folder}</span></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
