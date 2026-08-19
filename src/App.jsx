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

// giây -> "m:ss" / "h:mm:ss" để hiển thị trong ô sửa
const secToText = sec => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = n => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

export default function App() {
  const [mode, setMode] = useState('download') // 'download' | 'cut'
  const [defaultFolder, setDefaultFolder] = useState('')
  const [rows, setRows] = useState([newRow()])
  const [jobs, setJobs] = useState([])
  const [concurrency, setConcurrency] = useState(3)
  const [view, setView] = useState('list')
  const [submitting, setSubmitting] = useState(false)
  const [paused, setPaused] = useState(false)
  // null = bình thường | 'running' = đang cập nhật (khóa màn hình) | {ok, message} = kết quả
  const [upd, setUpd] = useState(null)
  // key dòng -> { status: 'analyzing' | 'ready' | 'error', name, segments, error }
  const [analysis, setAnalysis] = useState({})
  const [settings, setSettings] = useState(null) // { hasGeminiKey, prompt, model }
  const [settingsOpen, setSettingsOpen] = useState(false)
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
    fetch(`${API}/api/settings`)
      .then(r => r.json())
      .then(setSettings)
      .catch(() => {})
    return () => clearInterval(pollRef.current)
  }, [])

  const hasRunning = jobs.some(j => ['queued', 'downloading', 'cutting'].includes(j.status))
  const hasActive = jobs.some(j => j.status === 'downloading' || j.status === 'cutting' || (j.status === 'queued' && !paused))
  const hasPausable = jobs.some(j => ['queued', 'downloading', 'paused'].includes(j.status))
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

  const removeRow = key => {
    setRows(rs => rs.filter(r => r.key !== key))
    setAnalysis(a => {
      const next = { ...a }
      delete next[key]
      return next
    })
  }

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

  // ===== Chế độ cắt clip AI =====

  const patchAnalysis = (key, patch) =>
    setAnalysis(a => ({ ...a, [key]: { ...(a[key] || {}), ...patch } }))

  const analyzeAll = async () => {
    if (settings && !settings.hasGeminiKey) {
      setSettingsOpen(true)
      return
    }
    const targets = rows.filter(r => isYouTubeUrl(r.url) && analysis[r.key]?.status !== 'analyzing')
    if (!targets.length) return
    const pending = [...targets]
    // tối đa 2 video phân tích song song để không dồn quota Gemini
    const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (pending.length) {
        const r = pending.shift()
        patchAnalysis(r.key, { status: 'analyzing', error: '' })
        try {
          const res = await fetch(`${API}/api/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: r.url }),
          })
          const d = await res.json().catch(() => ({}))
          if (!res.ok || !d.ok) throw new Error(d.message || `Phân tích thất bại (HTTP ${res.status})`)
          patchAnalysis(r.key, {
            status: 'ready',
            name: d.name,
            segments: d.segments.map(s => ({ start: secToText(s.start), end: secToText(s.end), title: s.title })),
          })
        } catch (e) {
          patchAnalysis(r.key, { status: 'error', error: e?.message || 'Phân tích thất bại' })
          if (/API key/i.test(e?.message || '')) setSettingsOpen(true)
        }
      }
    })
    await Promise.all(workers)
  }

  const updateSegment = (key, idx, patch) =>
    setAnalysis(a => {
      const entry = a[key]
      if (!entry) return a
      const segments = entry.segments.map((s, i) => (i === idx ? { ...s, ...patch } : s))
      return { ...a, [key]: { ...entry, segments } }
    })

  const removeSegment = (key, idx) =>
    setAnalysis(a => {
      const entry = a[key]
      if (!entry) return a
      return { ...a, [key]: { ...entry, segments: entry.segments.filter((_, i) => i !== idx) } }
    })

  const addSegment = key =>
    setAnalysis(a => {
      const entry = a[key]
      if (!entry) return a
      return { ...a, [key]: { ...entry, segments: [...entry.segments, { start: '0:00', end: '3:00', title: '' }] } }
    })

  const readyRows = rows.filter(r => analysis[r.key]?.status === 'ready' && analysis[r.key].segments.length > 0)

  const cutAll = async () => {
    if (!readyRows.length) return
    setSubmitting(true)
    try {
      const items = readyRows.map(r => ({
        url: r.url,
        filename: r.filename || analysis[r.key].name,
        folder: r.folder,
        segments: analysis[r.key].segments,
      }))
      await fetch(`${API}/api/cut-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, concurrency }),
      })
      await refresh()
      const sent = new Set(readyRows.map(r => r.key))
      setRows(rs => {
        const left = rs.filter(r => !sent.has(r.key))
        return left.length ? left : [newRow(defaultFolder)]
      })
      setAnalysis(a => {
        const next = { ...a }
        for (const k of sent) delete next[k]
        return next
      })
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
      `Hủy "${name}"?\n\nTiến trình sẽ dừng ngay và file tạm sẽ bị dọn sạch khỏi máy. Muốn làm lại thì phải bắt đầu từ đầu đó nha!`
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

  const validCount = rows.filter(r => isYouTubeUrl(r.url)).length
  const analyzingCount = rows.filter(r => analysis[r.key]?.status === 'analyzing').length

  return (
    <div className="app">
      <header className="hero">
        <h1><span className="logo">▶</span>Youtube<span className="grad">Download Tool</span></h1>
        <p className="hint">
          {mode === 'download'
            ? 'Dán link → đặt tên → chọn folder → nhấn tải, xong! 🚀'
            : 'Dán link → AI xem video và đề xuất đoạn hay → duyệt/sửa → cắt thành clip nhỏ ✂️'}
        </p>
        <div className="mode-tabs">
          <button className={mode === 'download' ? 'active' : ''} onClick={() => setMode('download')}>⬇ Tải video</button>
          <button className={mode === 'cut' ? 'active' : ''} onClick={() => setMode('cut')}>✂️ Cắt clip AI</button>
          <button className="btn-icon gear" title="Cài đặt AI (API key, prompt)" onClick={() => setSettingsOpen(true)}>⚙️</button>
        </div>
      </header>

      {hasRunning && !paused && (
        <div className="warning-banner">
          <span className="warning-icon">⚡</span>
          <span>
            Đang chạy dở đó nha! Đừng vội đóng hay F5 trang — tiến trình đang chạy sẽ <b>không được nối lại</b>, phải làm lại từ đầu. Ráng chờ xíu, sắp xong rồi ☕
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

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={s => {
            setSettings(s)
            setSettingsOpen(false)
          }}
        />
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
                placeholder={mode === 'cut' ? 'Tên clip (trống = AI đặt)' : 'Tên file (tùy chọn)'}
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
            Chạy cùng lúc
            <select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} video</option>)}
            </select>
          </label>
          {mode === 'download' ? (
            <button className="primary" onClick={download} disabled={submitting || validCount === 0}>
              ⬇ Tải xuống ({validCount})
            </button>
          ) : (
            <>
              <button className="primary" onClick={analyzeAll} disabled={validCount === 0 || analyzingCount > 0}>
                {analyzingCount > 0 ? `🤖 Đang phân tích ${analyzingCount} video...` : `🤖 Phân tích AI (${validCount})`}
              </button>
              <button className="primary cut" onClick={cutAll} disabled={submitting || readyRows.length === 0}>
                ✂️ Cắt ({readyRows.length})
              </button>
            </>
          )}
        </div>
      </div>

      {mode === 'cut' && rows.some(r => analysis[r.key]) && (
        <div className="analysis">
          {rows.filter(r => analysis[r.key]).map(r => {
            const a = analysis[r.key]
            return (
              <div className={`ana ana-${a.status}`} key={r.key}>
                <div className="ana-head">
                  <span className="ana-name" title={r.url}>{a.name || r.filename || r.url}</span>
                  {a.status === 'analyzing' && <span className="ana-status">🤖 Gemini đang xem video, chờ 30–90 giây...</span>}
                  {a.status === 'error' && <span className="ana-status err">❌ {a.error}</span>}
                  {a.status === 'ready' && <span className="ana-status ok">✓ {a.segments.length} đoạn — sửa được trước khi cắt</span>}
                </div>
                {a.status === 'analyzing' && <div className="bar"><div className="bar-fill ana-pulse" style={{ width: '100%' }} /></div>}
                {a.status === 'ready' && (
                  <>
                    <table className="seg-table">
                      <thead>
                        <tr><th></th><th>Bắt đầu</th><th>Kết thúc</th><th>Tiêu đề clip</th><th></th></tr>
                      </thead>
                      <tbody>
                        {a.segments.map((s, i) => (
                          <tr key={i}>
                            <td className="seg-num">P{i + 1}</td>
                            <td><input className="seg-time" value={s.start} onChange={e => updateSegment(r.key, i, { start: e.target.value })} /></td>
                            <td><input className="seg-time" value={s.end} onChange={e => updateSegment(r.key, i, { end: e.target.value })} /></td>
                            <td><input className="seg-title" value={s.title} onChange={e => updateSegment(r.key, i, { title: e.target.value })} /></td>
                            <td><button className="btn-icon" title="Bỏ đoạn này" onClick={() => removeSegment(r.key, i)}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button className="seg-add" onClick={() => addSegment(r.key)}>＋ Thêm đoạn</button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

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
                  {j.status === 'cutting' && '✂️ Đang cắt'}
                  {j.status === 'paused' && '⏸ Tạm dừng'}
                  {j.status === 'done' && '✅ Xong'}
                  {j.status === 'error' && '❌ Lỗi'}
                </span>
                <span className="job-url" title={j.url}>{j.filename || j.url}</span>
                {j.status === 'done' && (
                  <button className="btn-icon btn-open" title="Mở thư mục chứa file" onClick={() => openFolder(j.id)}>📂</button>
                )}
                {['queued', 'downloading', 'cutting', 'paused'].includes(j.status) && (
                  <button className="btn-icon btn-cancel" title="Hủy job này" onClick={() => cancelJob(j)}>🗑</button>
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

// Danh sách dự phòng khi chưa có key / không gọi được Google
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-flash-latest', 'gemini-pro-latest']

function SettingsModal({ settings, onClose, onSaved }) {
  const [keyDraft, setKeyDraft] = useState('')
  const [promptDraft, setPromptDraft] = useState(settings?.prompt || '')
  const [modelDraft, setModelDraft] = useState(settings?.model || 'gemini-3.6-flash')
  const [models, setModels] = useState(FALLBACK_MODELS)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Lấy danh sách model thật từ Google (nếu đã có key) — dropdown không bao giờ lỗi thời
  useEffect(() => {
    fetch(`${API}/api/models`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.models?.length) {
          setModels(d.models.includes(modelDraft) ? d.models : [modelDraft, ...d.models])
        }
      })
      .catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geminiKey: keyDraft.trim() || undefined,
          prompt: promptDraft,
          model: modelDraft,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.message || `HTTP ${res.status}`)
      onSaved({ hasGeminiKey: d.hasGeminiKey, prompt: promptDraft, model: modelDraft })
    } catch (e) {
      setError('Không lưu được: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="overlay-card settings">
        <h3>⚙️ Cài đặt AI</h3>

        <label className="set-label">Gemini API key</label>
        <input
          type="password"
          className="set-input"
          placeholder={settings?.hasGeminiKey ? 'Đã lưu key ✓ — nhập key mới nếu muốn thay' : 'Dán API key (lấy tại aistudio.google.com/apikey)'}
          value={keyDraft}
          onChange={e => setKeyDraft(e.target.value)}
        />
        <p className="set-note">Key chỉ lưu trên máy này, không đưa lên mạng hay lên git.</p>

        <label className="set-label">Model</label>
        <select className="set-input" value={modelDraft} onChange={e => setModelDraft(e.target.value)}>
          {models.map(m => (
            <option key={m} value={m}>
              {m}{m === 'gemini-3.6-flash' ? ' — nhanh, rẻ (khuyên dùng)' : ''}{m.includes('pro') ? ' — kỹ hơn, chậm và đắt hơn' : ''}
            </option>
          ))}
        </select>
        <p className="set-note">Danh sách lấy trực tiếp từ Google theo key của bạn — model nào bị Google cho nghỉ hưu sẽ tự biến mất khỏi đây.</p>

        <label className="set-label">Prompt phân tích video</label>
        <textarea
          className="set-input set-prompt"
          rows={7}
          value={promptDraft}
          onChange={e => setPromptDraft(e.target.value)}
        />
        <p className="set-note">Mô tả cách AI chọn đoạn (số đoạn, độ dài, tiêu chí). Kết quả luôn được ép về đúng định dạng nên không cần dặn về format.</p>

        {error && <p className="set-error">{error}</p>}

        <div className="settings-actions">
          <button onClick={onClose}>Đóng</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? 'Đang lưu...' : 'Lưu cài đặt'}
          </button>
        </div>
      </div>
    </div>
  )
}
