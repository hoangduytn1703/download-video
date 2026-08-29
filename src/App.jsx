import { useEffect, useRef, useState } from 'react'
import { getApiBase, runtime } from './api.js'
import { isYouTubeUrl, parseVideoId } from './youtube.js'
import { parseSegmentsText, buildPrompt, validatePrompt, DEFAULT_CUT_PROMPT, jobsToEnqueueAfterAnalyze, cutUiForSource, segmentsToPipeText, segmentsToJson } from './parse.js'

export { isYouTubeUrl }

// Khi chạy bản build (GitHub Pages), gọi thẳng backend chạy trên máy người dùng
const API = getApiBase(runtime())

// Tạm ẩn nút "Tạm dừng tất cả" — đổi thành true khi muốn bật lại
const SHOW_PAUSE_ALL = false
// Phase 2: Gemini API analyze in-app (costs quota at volume).
const SHOW_AI_ANALYZE = true
// Tab Phan tich chi tra text (khong tai/khong cat) nen cho nhieu hon
const MAX_ANALYZE_ROWS = 40
// Tắt nút "AI trên YouTube" (playwright mở Chrome) — mong manh, rủi ro tài khoản Google.
// Code giữ nguyên, bật lại bằng flag này khi cần thử nghiệm.
const SHOW_YOUTUBE_ASK = false

let rowKey = 1
const newRow = (folder = '') => ({ key: rowKey++, url: '', filename: '', folder, aiText: '' })

// giây -> "m:ss" / "h:mm:ss" để hiển thị trong ô sửa
const secToText = sec => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = n => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

export default function App() {
  const [mode, setMode] = useState('analyze') // 'analyze' | 'cut'
  const [defaultFolder, setDefaultFolder] = useState('')
  // Danh sách link DÙNG CHUNG cho tab Phân tích và tab Cắt — dán một lần, hai tab cùng thấy.
  // Kết quả phân tích cũng dùng chung, nhưng tab Cắt KHÔNG tự hiện gì cả (cutShown) —
  // chỉ hiện/chạy khi bấm nút Phân tích hoặc Cắt bên tab đó.
  const [rows, setRows] = useState([newRow()])
  const [jobs, setJobs] = useState([])
  const [view, setView] = useState('list')
  const [submitting, setSubmitting] = useState(false)
  const [paused, setPaused] = useState(false)
  // null = bình thường | 'running' = đang cập nhật (khóa màn hình) | {ok, message} = kết quả
  const [upd, setUpd] = useState(null)
  // key dòng -> { status: 'analyzing' | 'ready' | 'error', name, segments, error }
  const [analysis, setAnalysis] = useState({})
  const [settings, setSettings] = useState(null) // { hasGeminiKey, prompt, model }
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Nguồn mốc cắt ở tab Cắt: 'analysis' = dùng kết quả đã phân tích (không tốn token),
  // 'custom' = phân tích lại bằng prompt nhập tay, 'settings' = phân tích bằng prompt trong Cài đặt
  const [cutSource, setCutSource] = useState('analysis')
  const [customPrompt, setCustomPrompt] = useState('')
  // Tab Cắt KHÔNG tự bung kết quả theo tab 1 — chỉ hiện khi bấm nút Phân tích bên tab này
  const [cutShown, setCutShown] = useState(false)
  // Đếm ngược nghỉ 5 giây sau mỗi lượt phân tích — chống bấm dồn dập tốn token
  const [cooldown, setCooldown] = useState(0)
  const [copiedKey, setCopiedKey] = useState(null) // key dòng vừa copy kết quả, hoặc 'ALL' / 'link:<key>'
  // Các dòng đang chạy "phân tích lại" riêng lẻ
  const [rerunKeys, setRerunKeys] = useState(() => new Set())
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
    // Đồng bộ danh sách job ngay khi mở app — tránh hiện job "ma" từ phiên trước
    refresh().catch(() => {})
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

  // Tick đếm ngược cooldown 5s sau mỗi lượt phân tích
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

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

  // Link trùng nhau (so theo video id nên youtu.be/X và watch?v=X vẫn bắt được):
  // dòng sau bị đánh dấu trùng và loại khỏi mọi hành động — không phân tích 2 lần tốn token.
  // Khai báo TRƯỚC mọi chỗ dùng trong thân component (từng bị lỗi TDZ vì đặt phía dưới).
  const dupKeys = (() => {
    const seen = new Set()
    const dups = new Set()
    for (const r of rows) {
      const id = parseVideoId(r.url)
      if (!id) continue
      if (seen.has(id)) dups.add(r.key)
      else seen.add(id)
    }
    return dups
  })()
  const usableRows = rows.filter(r => isYouTubeUrl(r.url) && !dupKeys.has(r.key))
  const validCount = usableRows.length

  // Xóa kết quả phân tích của một dòng — link vẫn giữ nguyên trong danh sách
  const clearAnalysis = key =>
    setAnalysis(a => {
      const next = { ...a }
      delete next[key]
      return next
    })

  const removeRow = key => {
    setRows(rs => rs.filter(r => r.key !== key))
    clearAnalysis(key)
  }

  const rowLimit = MAX_ANALYZE_ROWS // danh sách link dùng chung 2 tab
  const atRowLimit = rows.length >= rowLimit

  const addRow = () => setRows(rs => (rs.length >= rowLimit ? rs : [...rs, newRow(defaultFolder)]))

  const pasteLinks = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const found = text.split(/[\s,]+/).filter(s => /^https?:\/\//.test(s))
      const seenIds = new Set(rows.map(r => parseVideoId(r.url)).filter(Boolean))
      const urls = []
      for (const u of found.filter(isYouTubeUrl)) {
        const id = parseVideoId(u)
        if (!id || seenIds.has(id)) continue
        seenIds.add(id)
        urls.push(u)
      }
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
        while (i < urls.length && filled.length < rowLimit) filled.push({ ...newRow(defaultFolder), url: urls[i++] })
        if (i < urls.length) {
          alert(`Tab này nhận tối đa ${rowLimit} link mỗi lần — đã lấy ${filled.length} link đầu.`)
        }
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

  // ===== Chế độ cắt clip AI =====

  const patchAnalysis = (key, patch) =>
    setAnalysis(a => ({ ...a, [key]: { ...(a[key] || {}), ...patch } }))

  const enqueueCutJobs = async items => {
    if (!items.length) return
    await fetch(`${API}/api/cut-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, concurrency: Math.min(items.length, 10) }),
    })
    await refresh()
  }

  // Tải NGUYÊN video (bản full 1080p, không cắt) về folder của từng dòng
  const downloadFull = async targetRows => {
    const items = targetRows
      .filter(r => isYouTubeUrl(r.url) && !dupKeys.has(r.key))
      .map(r => ({ url: r.url, filename: r.filename || analysis[r.key]?.name || '', folder: r.folder }))
    if (!items.length) return
    await fetch(`${API}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, concurrency: Math.min(items.length, 10) }),
    })
    await refresh()
  }

  // Tải kết quả ra file .json đúng định dạng công cụ dựng clip của team
  const saveJson = (suggestedName, data) => {
    const safe = String(suggestedName || 'ket-qua').replace(/[<>:"/\\|?*]+/g, '').trim() || 'ket-qua'
    const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = safe.toLowerCase().endsWith('.json') ? safe : safe + '.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  const copyResult = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 2000)
    } catch {
      alert(text)
    }
  }


  // Thiếu key thì giải thích rõ rồi mới mở Cài đặt — trước đây Settings tự bật lên
  // mà không nói gì, người dùng tưởng app lỗi.
  const requireKey = () => {
    if (settings && !settings.hasGeminiKey) {
      const why = settings.configError
        ? settings.configError
        : 'Máy này chưa có Gemini API key nên chưa phân tích được.'
      alert([why, '', 'Mở Cài đặt ⚙️ và dán API key (lấy miễn phí tại aistudio.google.com/apikey), bấm Lưu là dùng được ngay.'].join('\n'))
      setSettingsOpen(true)
      return false
    }
    return true
  }

  const analyzeAll = async () => {
    if (!requireKey()) return
    const targets = rows.filter(r => isYouTubeUrl(r.url) && !dupKeys.has(r.key) && analysis[r.key]?.status !== 'analyzing')
    if (!targets.length) return
    await runAnalysisPool(targets, { onReady: null, promptOverride: null })
    setCooldown(5)
  }

  // Chạy phân tích song song (tối đa 5). onReady được gọi từng link khi xong —
  // tab Cắt dùng để enqueue job cắt ngay; tab Phân tích thì chỉ hiển thị.
  const runAnalysisPool = async (targets, { onReady, promptOverride }) => {
    const pending = [...targets]
    const workers = Array.from({ length: Math.min(5, pending.length) }, async () => {
      while (pending.length) {
        const r = pending.shift()
        patchAnalysis(r.key, { status: 'analyzing', error: '' })
        try {
          const res = await fetch(`${API}/api/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: r.url, source: 'app', prompt: promptOverride || undefined }),
          })
          const d = await res.json().catch(() => ({}))
          if (!res.ok || !d.ok) throw new Error(d.message || `Phân tích thất bại (HTTP ${res.status})`)
          const ready = {
            status: 'ready',
            name: d.name,
            segments: d.segments.map(s => ({ start: secToText(s.start), end: secToText(s.end), title: s.title })),
          }
          patchAnalysis(r.key, ready)
          if (onReady) await onReady(r, ready)
        } catch (e) {
          patchAnalysis(r.key, { status: 'error', error: e?.message || 'Phân tích thất bại' })
          if (/API key/i.test(e?.message || '')) setSettingsOpen(true)
        }
      }
    })
    await Promise.all(workers)
  }

  // Phân tích lại đúng MỘT video — dùng khi cả loạt chỉ có 1-2 cái ra kết quả sai,
  // không phải chạy lại hết cho tốn token.
  const reanalyzeOne = async (row, promptOverride = null) => {
    if (!requireKey()) return
    if (analysis[row.key]?.status === 'analyzing') return
    setRerunKeys(s2 => new Set(s2).add(row.key))
    try {
      await runAnalysisPool([row], { onReady: null, promptOverride })
    } finally {
      setRerunKeys(s2 => {
        const next = new Set(s2)
        next.delete(row.key)
        return next
      })
    }
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

  const readyRows = rows.filter(r => analysis[r.key]?.status === 'ready' && analysis[r.key].segments.length > 0 && !dupKeys.has(r.key))

  // Nút Phân tích bên tab Cắt — chạy theo option đang chọn, CHỈ phân tích + hiện kết quả
  // để xem/sửa (chưa cắt). Với option "dùng kết quả đã phân tích" thì chỉ hiển thị lại,
  // không gọi AI nên không tốn token.
  const analyzeForCut = async () => {
    if (cutSource === 'analysis') {
      setCutShown(true)
      return
    }
    if (!requireKey()) return
    const promptOverride = cutSource === 'custom' ? customPrompt.trim() : null
    if (cutSource === 'custom' && !promptOverride) {
      alert('Bạn đang chọn "Prompt mới" nhưng chưa nhập prompt.')
      return
    }
    const targets = usableRows.filter(r => analysis[r.key]?.status !== 'analyzing')
    if (!targets.length) return
    setCutShown(true)
    await runAnalysisPool(targets, { promptOverride, onReady: null })
    setCooldown(5)
  }

  const cutAll = async () => {
    setSubmitting(true)
    try {
      if (cutSource === 'analysis') {
        // Dùng kết quả đã phân tích — KHÔNG gọi AI, không tốn token
        if (!readyRows.length) return
        const items = readyRows.flatMap(r => jobsToEnqueueAfterAnalyze(true, r, analysis[r.key]))
        await enqueueCutJobs(items)
        return
      }
      // Prompt mới hoặc prompt trong Cài đặt: phân tích lại rồi cắt ngay từng link khi xong
      if (!requireKey()) return
      const targets = usableRows.filter(r => analysis[r.key]?.status !== 'analyzing')
      if (!targets.length) return
      const promptOverride = cutSource === 'custom' ? customPrompt.trim() : null
      if (cutSource === 'custom' && !promptOverride) {
        alert('Bạn đang chọn "Prompt mới" nhưng chưa nhập prompt.')
        return
      }
      setCutShown(true)
      await runAnalysisPool(targets, {
        promptOverride,
        onReady: async (r, ready) => {
          const items = jobsToEnqueueAfterAnalyze(true, r, ready)
          if (items.length) await enqueueCutJobs(items)
        },
      })
      setCooldown(5)
    } finally {
      setSubmitting(false)
    }
  }

  const clearFinished = async () => {
    await fetch(`${API}/api/jobs/clear-finished`, { method: 'POST' })
    await refresh()
  }

  const openFolder = async id => {
    const res = await fetch(`${API}/api/jobs/${id}/open`, { method: 'POST' }).catch(() => null)
    if (res?.ok) return
    // Job không còn bên server (thường do server khởi động lại — danh sách job nằm trong RAM)
    alert('Mục này không còn trên máy chủ nữa (app đã khởi động lại). Mở thư mục thủ công giúp nhé — danh sách sẽ được làm mới.')
    await refresh()
  }

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

  const analyzingCount = rows.filter(r => analysis[r.key]?.status === 'analyzing').length

  return (
    <div className="app">
      <header className="hero">
        <h1><span className="logo">▶</span>Youtube<span className="grad">Download Tool</span></h1>
        <p className="hint">
          {mode === 'analyze'
            ? 'Dán link → Phân tích → nhận text kết quả cắt → Copy / Lưu .txt. Muốn cắt thì qua tab Cắt clip 📋'
            : 'Link dùng chung với tab Phân tích. Chọn nguồn mốc cắt → bấm Phân tích để xem/sửa mốc, hoặc Cắt để chạy luôn ✂️'}
        </p>
        <div className="mode-tabs">
          <button className={mode === 'analyze' ? 'active' : ''} onClick={() => setMode('analyze')}>🔍 Phân tích</button>
          <button className={mode === 'cut' ? 'active' : ''} onClick={() => setMode('cut')}>✂️ Cắt clip</button>
          <button className="btn-icon gear" title="Sửa prompt hỏi AI" onClick={() => setSettingsOpen(true)}>⚙️</button>
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

      {settings && (!settings.hasGeminiKey || settings.configError) && (
        <div className="error-banner">
          <span className="warning-icon">🔑</span>
          <span>
            {settings.configError
              ? settings.configError
              : 'Chưa có Gemini API key trên máy này nên chưa phân tích được. Bấm nút bên cạnh để nhập key (lấy miễn phí tại aistudio.google.com/apikey) — key chỉ lưu trên máy này.'}
          </span>
          <button className="btn-reset" onClick={() => setSettingsOpen(true)}>⚙️ Nhập API key</button>
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

      <div className={`card${hasRunning ? ' locked' : ''}`}>
        {hasRunning && (
          <div className="locked-note">
            🔒 Đang xử lý — chờ xong rồi thêm link mới nhé (tránh dồn việc cùng lúc)
          </div>
        )}
        <div className="rows">
          {rows.map((r, i) => {
            const urlInvalid = r.url.trim() !== '' && !isYouTubeUrl(r.url)
            const urlDup = dupKeys.has(r.key)
            return (
            <div className="row-wrap" key={r.key}>
            <div className="row">
              <span className="row-num">{i + 1}</span>
              <input
                className={`url${urlInvalid || urlDup ? ' invalid' : ''}`}
                placeholder="https://www.youtube.com/watch?v=..."
                value={r.url}
                onChange={e => updateRow(r.key, { url: e.target.value })}
                disabled={hasRunning}
              />
              {mode !== 'analyze' && (
                <input
                  className="filename"
                  placeholder={mode === 'cut' ? 'Tên clip (trống = AI đặt)' : 'Tên file (tùy chọn)'}
                  value={r.filename}
                  onChange={e => updateRow(r.key, { filename: e.target.value })}
                  disabled={hasRunning}
                />
              )}
              {mode !== 'analyze' && (
                <input
                  className="folder"
                  placeholder="Thư mục tải về"
                  value={r.folder}
                  onChange={e => updateRow(r.key, { folder: e.target.value })}
                  disabled={hasRunning}
                />
              )}
              {mode !== 'analyze' && (
                <button className="btn-icon" title="Chọn thư mục" onClick={() => pickFolder(r.key)} disabled={hasRunning}>📁</button>
              )}
              <button
                className="btn-icon"
                title="Xóa dòng"
                onClick={() => removeRow(r.key)}
                disabled={rows.length === 1 || hasRunning}
              >✕</button>
            </div>
            {urlInvalid && (
              <div className="row-error">⚠ Link không hợp lệ — chỉ nhận link YouTube (youtube.com / youtu.be) thôi nha</div>
            )}
            {urlDup && (
              <div className="row-error">⚠ Link này trùng với một dòng phía trên — sẽ được bỏ qua để không phân tích 2 lần</div>
            )}
            </div>
          )})}
        </div>

        <div className="actions">
          <button
            onClick={addRow}
            disabled={hasRunning || atRowLimit}
            title={atRowLimit ? `Tối đa ${rowLimit} link mỗi lần` : ''}
          >＋ Thêm link</button>
          <button onClick={pasteLinks} disabled={hasRunning}>📋 Dán nhiều link</button>
          <span className="row-count">{rows.length}/{rowLimit} link</span>
          {mode === 'analyze' && (
            <button className="primary" onClick={analyzeAll} disabled={validCount === 0 || analyzingCount > 0 || cooldown > 0}>
              {analyzingCount > 0
                ? `🔍 Đang phân tích ${analyzingCount} video...`
                : cooldown > 0
                ? `⏳ Nghỉ ${cooldown}s...`
                : `🔍 Phân tích (${validCount})`}
            </button>
          )}
          {mode === 'cut' && (
            <>
              <button
                onClick={() => downloadFull(usableRows)}
                disabled={hasRunning || validCount === 0}
                title="Tải nguyên video (bản full 1080p, không cắt) của tất cả link về folder"
              >⬇ Tải tất cả ({validCount})</button>
              <button
                onClick={analyzeForCut}
                disabled={analyzingCount > 0 || cooldown > 0 || (cutSource === 'analysis' ? readyRows.length === 0 : validCount === 0)}
                title={cutSource === 'analysis'
                  ? 'Hiện kết quả đã phân tích ra để xem/sửa — không tốn token'
                  : 'Phân tích theo lựa chọn bên dưới để xem/sửa mốc cắt (chưa cắt)'}
              >
                {analyzingCount > 0
                  ? `🔍 Đang phân tích ${analyzingCount}...`
                  : cooldown > 0
                  ? `⏳ Nghỉ ${cooldown}s...`
                  : `🔍 Phân tích (${cutSource === 'analysis' ? readyRows.length : validCount})`}
              </button>
              <button
                className="primary cut"
                onClick={cutAll}
                disabled={submitting || hasRunning || analyzingCount > 0 || (cutSource === 'analysis' ? readyRows.length === 0 : validCount === 0 || cooldown > 0)}
              >
                {analyzingCount > 0
                  ? `✂️ Chờ phân tích xong...`
                  : cutSource !== 'analysis' && cooldown > 0
                  ? `⏳ Nghỉ ${cooldown}s...`
                  : `✂️ Cắt (${cutSource === 'analysis' ? readyRows.length : validCount})`}
              </button>
            </>
          )}
        </div>

        {mode === 'cut' && (
          <div className="cut-source">
            <label className="set-check">
              <input type="radio" name="cutsrc" checked={cutSource === 'analysis'} onChange={() => setCutSource('analysis')} />
              <span>
                <b>Dùng kết quả đã phân tích</b> — không tốn token
                {readyRows.length ? ` (${readyRows.length} video sẵn sàng)` : ' (chưa có — qua tab Phân tích chạy trước)'}
              </span>
            </label>
            <label className="set-check">
              <input type="radio" name="cutsrc" checked={cutSource === 'settings'} onChange={() => setCutSource('settings')} />
              <span><b>Phân tích bằng prompt trong Cài đặt</b> rồi cắt luôn</span>
            </label>
            <label className="set-check">
              <input type="radio" name="cutsrc" checked={cutSource === 'custom'} onChange={() => setCutSource('custom')} />
              <span><b>Phân tích bằng prompt mới</b> (nhập bên dưới) rồi cắt luôn</span>
            </label>
            {cutSource === 'custom' && (
              <textarea
                className="ai-paste"
                rows={4}
                placeholder="Nhập prompt mới cho lần cắt này (app vẫn tự nối quy tắc định dạng + ngôn ngữ)..."
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
                disabled={hasRunning || analyzingCount > 0}
              />
            )}
          </div>
        )}
      </div>

      {mode === 'analyze' && rows.some(r => analysis[r.key]) && (
        <div className="analysis">
          {rows.filter(r => analysis[r.key]?.status === 'ready').length > 1 && (
            <div className="results-tools">
              <button
                title="Tải tất cả kết quả ra một file .json (mảng các video)"
                onClick={() => saveJson('ket-qua-phan-tich',
                  rows
                    .filter(r => analysis[r.key]?.status === 'ready')
                    .map(r => segmentsToJson(r.url, analysis[r.key].name, analysis[r.key].segments))
                )}
              >⬇ Tải tất cả .json</button>
              <button
                onClick={() => copyResult('ALL',
                  rows
                    .filter(r => analysis[r.key]?.status === 'ready')
                    .map(r => segmentsToPipeText(analysis[r.key].name, analysis[r.key].segments))
                    .join('\n\n')
                )}
              >
                {copiedKey === 'ALL' ? '✓ Đã copy tất cả!' : `📋 Copy tất cả (${rows.filter(r => analysis[r.key]?.status === 'ready').length})`}
              </button>
            </div>
          )}
          {rows.filter(r => analysis[r.key]).map(r => {
            const a = analysis[r.key]
            const pipe = a.status === 'ready' ? segmentsToPipeText(a.name, a.segments) : ''
            return (
              <div className={`ana ana-${a.status}`} key={r.key}>
                <div className="ana-head">
                  <a className="ana-link" href={r.url} target="_blank" rel="noreferrer" title={a.name || r.url}>{r.url}</a>
                  <button
                    className="btn-icon"
                    title="Copy link YouTube này"
                    onClick={() => copyResult(`link:${r.key}`, r.url)}
                  >{copiedKey === `link:${r.key}` ? '✓' : '🔗'}</button>
                  {a.status === 'analyzing' && <span className="ana-status">🔍 Đang phân tích, thường 5–10 giây...</span>}
                  {a.status === 'error' && <span className="ana-status err">❌ {a.error}</span>}
                  {a.status === 'ready' && <span className="ana-status ok">✓ {a.segments.length} đoạn — sửa trực tiếp bên dưới</span>}
                  {(a.status === 'ready' || a.status === 'error') && (
                    <button
                      className="btn-icon"
                      title="Phân tích lại riêng video này (chỉ tốn 1 lượt AI)"
                      onClick={() => reanalyzeOne(r)}
                      disabled={rerunKeys.has(r.key)}
                    >{rerunKeys.has(r.key) ? '⏳' : '🔄 Phân tích lại'}</button>
                  )}
                  {a.status === 'ready' && (
                    <>
                      <button
                        className="btn-icon"
                        title="Tải kết quả này ra file .json (định dạng công cụ dựng clip)"
                        onClick={() => saveJson(a.name || 'ket-qua', segmentsToJson(r.url, a.name, a.segments))}
                      >⬇ JSON</button>
                      <button className="btn-copy-result" onClick={() => copyResult(r.key, pipe)}>
                        {copiedKey === r.key ? '✓ Đã copy!' : '📋 Copy kết quả'}
                      </button>
                    </>
                  )}
                  {a.status !== 'analyzing' && (
                    <button className="btn-icon" title="Xóa kết quả này (link vẫn giữ trong danh sách)" onClick={() => clearAnalysis(r.key)}>✕</button>
                  )}
                </div>
                {a.status === 'analyzing' && <div className="bar"><div className="bar-fill ana-pulse" style={{ width: '100%' }} /></div>}
                {a.status === 'ready' && (
                  <SegmentEditor
                    entry={a}
                    onName={name => patchAnalysis(r.key, { name })}
                    onSegment={(i, patch) => updateSegment(r.key, i, patch)}
                    onRemove={i => removeSegment(r.key, i)}
                    onAdd={() => addSegment(r.key)}
                  />
                )}
                {a.status === 'ready' && (
                  <details className="pipe-details">
                    <summary>Xem text kết quả (đúng bản sẽ được copy)</summary>
                    <pre className="pipe-text">{pipe}</pre>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}

      {mode === 'cut' && cutShown && rows.some(r => analysis[r.key]) && (
        <div className="analysis">
          {rows.filter(r => analysis[r.key]).map(r => {
            const a = analysis[r.key]
            return (
              <div className={`ana ana-${a.status}`} key={r.key}>
                <div className="ana-head">
                  <span className="ana-name" title={r.url}>{a.name || r.filename || r.url}</span>
                  {a.status === 'analyzing' && <span className="ana-status">🤖 Gemini đang xem video, chờ 30–90 giây...</span>}
                  {a.status === 'error' && <span className="ana-status err">❌ {a.error}</span>}
                  {a.status === 'ready' && <span className="ana-status ok">✓ {a.segments.length} đoạn — muốn sửa thì qua tab Phân tích</span>}
                  {(a.status === 'ready' || a.status === 'error') && (
                    <button
                      className="btn-icon"
                      title={cutSource === 'custom'
                        ? 'Phân tích lại video này bằng prompt mới đang nhập'
                        : 'Phân tích lại riêng video này (chỉ tốn 1 lượt AI)'}
                      onClick={() => reanalyzeOne(r, cutSource === 'custom' ? customPrompt.trim() || null : null)}
                      disabled={rerunKeys.has(r.key) || hasRunning}
                    >{rerunKeys.has(r.key) ? '⏳' : '🔄 Phân tích lại'}</button>
                  )}
                  {a.status === 'ready' && (
                    <button
                      className="btn-icon btn-dl-one"
                      title="Tải nguyên video này (bản full 1080p) về folder"
                      onClick={() => downloadFull(rows.filter(x => x.key === r.key))}
                      disabled={hasRunning}
                    >⬇ Tải video này</button>
                  )}
                  {a.status !== 'analyzing' && (
                    <button className="btn-icon" title="Xóa kết quả này (link vẫn giữ trong danh sách)" onClick={() => clearAnalysis(r.key)}>✕</button>
                  )}
                </div>
                {a.status === 'analyzing' && <div className="bar"><div className="bar-fill ana-pulse" style={{ width: '100%' }} /></div>}
                {a.status === 'ready' && <SegmentEditor entry={a} readOnly />}
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

      <UpdateBar />

      <footer className="footer">© 2026 - code by Nguyễn Hoàng Duy</footer>
    </div>
  )
}

// Bảng mốc cắt dùng chung 2 tab: tab Phân tích cho sửa (tên, mốc, tiêu đề, bỏ/thêm đoạn),
// tab Cắt chỉ xem lại — dữ liệu là một, sửa bên Phân tích thì bên Cắt thấy ngay.
function SegmentEditor({ entry, readOnly = false, onName, onSegment, onRemove, onAdd }) {
  return (
    <>
      {!readOnly && (
        <input
          className="ana-name-edit"
          value={entry.name || ''}
          placeholder="Tên video (AI đặt) — sửa được"
          onChange={e => onName(e.target.value)}
        />
      )}
      <table className={'seg-table' + (readOnly ? ' readonly' : '')}>
        <thead>
          <tr><th></th><th>Bắt đầu</th><th>Kết thúc</th><th>Tiêu đề clip</th>{!readOnly && <th></th>}</tr>
        </thead>
        <tbody>
          {entry.segments.map((seg, i) => (
            <tr key={i}>
              <td className="seg-num">P{i + 1}</td>
              <td><input className="seg-time" value={seg.start} readOnly={readOnly} onChange={e => onSegment?.(i, { start: e.target.value })} /></td>
              <td><input className="seg-time" value={seg.end} readOnly={readOnly} onChange={e => onSegment?.(i, { end: e.target.value })} /></td>
              <td><input className="seg-title" value={seg.title} readOnly={readOnly} onChange={e => onSegment?.(i, { title: e.target.value })} /></td>
              {!readOnly && <td><button className="btn-icon" title="Bỏ đoạn này" onClick={() => onRemove(i)}>✕</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && <button className="seg-add" onClick={onAdd}>＋ Thêm đoạn</button>}
    </>
  )
}

// Thanh cập nhật app — chỉ hiện khi chạy trong app desktop bản cài đặt
function UpdateBar() {
  const [u, setU] = useState(null)
  const timerRef = useRef(null)

  const load = async () => {
    const d = await fetch(`${API}/api/app-update`).then(r => r.json()).catch(() => null)
    if (d) setU(d)
    return d
  }

  useEffect(() => {
    load()
    return () => clearInterval(timerRef.current)
  }, [])

  // đang kiểm tra / tải thì hỏi liên tục cho thanh tiến trình chạy
  useEffect(() => {
    const busy = u && ['checking', 'downloading'].includes(u.state)
    if (busy && !timerRef.current) timerRef.current = setInterval(load, 1000)
    if (!busy && timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [u?.state])

  const act = async action => {
    const d = await fetch(`${API}/api/app-update/${action}`, { method: 'POST' })
      .then(r => r.json())
      .catch(() => null)
    if (d) setU(d)
  }

  const toggleAuto = async enabled => {
    const d = await fetch(`${API}/api/app-update/auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then(r => r.json()).catch(() => null)
    if (d) setU(d)
  }

  if (!u?.supported) return null

  return (
    <div className={`upd-bar${u.state === 'available' || u.state === 'downloaded' ? ' hot' : ''}`}>
      <span className="upd-ver">Phiên bản {u.currentVersion}</span>

      {u.state === 'checking' && <span className="upd-msg">Đang kiểm tra bản mới...</span>}
      {u.state === 'not-available' && <span className="upd-msg">Đang dùng bản mới nhất ✓</span>}
      {u.state === 'available' && (
        <>
          <span className="upd-msg">🎉 Có bản mới {u.newVersion}!</span>
          <button className="upd-btn" onClick={() => act('download')}>⬇ Tải bản mới</button>
        </>
      )}
      {u.state === 'downloading' && (
        <span className="upd-msg">Đang tải bản mới... {u.percent}%</span>
      )}
      {u.state === 'downloaded' && (
        <>
          <span className="upd-msg">✓ Đã tải xong bản {u.newVersion}</span>
          <button className="upd-btn" onClick={() => act('install')}>🔄 Khởi động lại để cài</button>
        </>
      )}
      {u.state === 'error' && <span className="upd-msg err">Không kiểm tra được: {u.error}</span>}

      {!['checking', 'downloading', 'downloaded'].includes(u.state) && (
        <button className="upd-check" onClick={() => act('check')}>Kiểm tra cập nhật</button>
      )}

      <label className="upd-auto">
        <input type="checkbox" checked={u.autoCheck} onChange={e => toggleAuto(e.target.checked)} />
        Tự kiểm tra khi mở app
      </label>
    </div>
  )
}

// Ngôn ngữ đầu ra cho tiêu đề clip — giá trị được chèn thẳng vào prompt
const LANGUAGES = ['Tây Ban Nha', 'Anh', 'Việt', 'Bồ Đào Nha', 'Pháp', 'Đức', 'Indonesia', 'Thái', 'Nhật', 'Hàn', 'Trung']

// Danh sách dự phòng khi chưa có key / không gọi được Google
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-flash-latest', 'gemini-pro-latest']

function SettingsModal({ settings, onClose, onSaved }) {
  const [keyDraft, setKeyDraft] = useState('')
  const [clearKeys, setClearKeys] = useState(false)
  const [promptDraft, setPromptDraft] = useState(settings?.prompt || DEFAULT_CUT_PROMPT)
  const [langDraft, setLangDraft] = useState(settings?.language || 'Tây Ban Nha')
  const [speedDraft, setSpeedDraft] = useState(settings?.speedMode === 'quality' ? 'quality' : 'fast')
  const [modelDraft, setModelDraft] = useState(settings?.model || 'gemini-3.6-flash')
  const [models, setModels] = useState(FALLBACK_MODELS)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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

  // Nhập key từ file .txt — mỗi dòng một key (nhận cả phẩy / khoảng trắng)
  const importKeysFile = e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      // bỏ dòng ghi chú / chữ lẻ: key Gemini luôn là chuỗi dài, không có khoảng trắng
      const found = String(reader.result || '').split(/[\s,]+/).map(k => k.trim()).filter(k => k.length >= 20)
      if (!found.length) { setError('File không có dòng nào giống API key'); return }
      setError('')
      setKeyDraft(d => [...new Set([...d.split(/[\s,]+/).filter(Boolean), ...found])].join('\n'))
      setClearKeys(false)
    }
    reader.onerror = () => setError('Không đọc được file')
    reader.readAsText(file)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // mỗi dòng (hoặc phẩy/khoảng trắng) một key; để trống thì giữ key cũ
          geminiKeys: clearKeys
            ? []
            : (keyDraft.split(/[\s,]+/).map(k => k.trim()).filter(Boolean).length
              ? keyDraft.split(/[\s,]+/).map(k => k.trim()).filter(Boolean)
              : undefined),
          prompt: promptDraft,
          appendFormatRules: true,
          model: modelDraft,
          speedMode: speedDraft,
          language: langDraft,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.message || `HTTP ${res.status}`)
      onSaved(d)
    } catch (e) {
      setError('Không lưu được: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="overlay-card settings">
        <h3>⚙️ Cài đặt</h3>

        <label className="set-label">Prompt phân tích video</label>
        <textarea
          className="set-input set-prompt"
          rows={8}
          value={promptDraft}
          onChange={e => setPromptDraft(e.target.value)}
          placeholder={DEFAULT_CUT_PROMPT}
        />
        <button className="set-reset" onClick={() => setPromptDraft(DEFAULT_CUT_PROMPT)}>↺ Về prompt mặc định</button>
        <p className="set-note">App tự nối quy tắc định dạng + ngôn ngữ vào cuối prompt — viết kiểu gì kết quả cũng cắt được.</p>

        <label className="set-label">Ngôn ngữ tiêu đề clip</label>
        <select className="set-input" value={langDraft} onChange={e => setLangDraft(e.target.value)}>
          {[langDraft, ...LANGUAGES.filter(l => l !== langDraft)].map(l => (
            <option key={l} value={l}>tiếng {l}</option>
          ))}
        </select>

        <label className="set-label">Tốc độ phân tích</label>
        <div className="speed-options">
          <label className="set-check">
            <input type="radio" name="speed" checked={speedDraft === 'fast'} onChange={() => setSpeedDraft('fast')} />
            <span>⚡ <b>Nhanh</b> (~5–10 giây/video)</span>
          </label>
          <label className="set-check">
            <input type="radio" name="speed" checked={speedDraft === 'quality'} onChange={() => setSpeedDraft('quality')} />
            <span>🎯 <b>Kỹ</b> (~30 giây/video, tiêu đề hook mạnh hơn)</span>
          </label>
        </div>

        {settings?.configError && (
          <p className="set-error">⚠ {settings.configError}<br />File cài đặt: <code>{settings.configFile}</code></p>
        )}

        <label className="set-label">
          Gemini API key {settings?.keyCount > 0 && `(đang lưu ${settings.keyCount} key)`}
        </label>
        <textarea
          className="set-input set-keys"
          rows={4}
          placeholder={settings?.hasGeminiKey
            ? 'Đã lưu key ✓ — dán key mới vào đây nếu muốn thay hoặc thêm'
            : 'Dán API key (lấy tại aistudio.google.com/apikey)\nNhiều key thì mỗi dòng một key'}
          value={keyDraft}
          onChange={e => setKeyDraft(e.target.value)}
        />
        <p className="set-note">
          Dán được <b>nhiều key một lúc</b> — mỗi dòng một key. App tự xoay vòng, key nào hết lượt
          thì tự chuyển sang key kế tiếp. Để trống là giữ nguyên các key đã lưu.
          <label className="set-file" title="Chọn file .txt, mỗi dòng một key">
            📄 Nhập từ file .txt
            <input type="file" accept=".txt,text/plain" hidden onChange={importKeysFile} />
          </label>
          {settings?.keyCount > 0 && (
            <> <button className="set-reset set-clear-keys" onClick={() => { setKeyDraft(''); setClearKeys(true) }}>
              {clearKeys ? '✓ Sẽ xóa hết key khi Lưu' : '🗑 Xóa hết key đã lưu'}
            </button></>
          )}
        </p>

        <label className="set-label">Model</label>
        <select className="set-input" value={modelDraft} onChange={e => setModelDraft(e.target.value)}>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

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
