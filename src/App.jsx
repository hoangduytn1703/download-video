import { useEffect, useRef, useState } from 'react'
import { getApiBase, runtime } from './api.js'
import { isYouTubeUrl, parseVideoId, isChannelUrl } from './youtube.js'
import { isTikTokUrl, tiktokHandle, tiktokProfileUrl, normalizeTikTokInput, parseTikTokInputs } from './tiktok-url.js'
import { parseSegmentsText, buildPrompt, validatePrompt, DEFAULT_CUT_PROMPT, jobsToEnqueueAfterAnalyze, cutUiForSource, segmentsToPipeText, segmentsToJson } from './parse.js'

export { isYouTubeUrl }

// Khi chạy bản build (GitHub Pages), gọi thẳng backend chạy trên máy người dùng
const API = getApiBase(runtime())

// Tạm ẩn nút "Tạm dừng tất cả" — đổi thành true khi muốn bật lại
const SHOW_PAUSE_ALL = false
// Phase 2: Gemini API analyze in-app (costs quota at volume).
const SHOW_AI_ANALYZE = true
// Không giới hạn số link phân tích (giữ trần an toàn 1000 để tránh dán nhầm hàng vạn dòng)
const MAX_ANALYZE_ROWS = 1000
// Tắt nút "AI trên YouTube" (playwright mở Chrome) — mong manh, rủi ro tài khoản Google.
// Code giữ nguyên, bật lại bằng flag này khi cần thử nghiệm.
const SHOW_YOUTUBE_ASK = false

let rowKey = 1
let chanKey = 1
const newChan = () => ({ key: chanKey++, url: '' })
let ttRowKey = 1
const newTtRow = () => ({ key: 'tt' + ttRowKey++, url: '' })
const newRow = (folder = '') => ({ key: rowKey++, url: '', filename: '', folder, aiText: '', segCount: null })

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
  // Text nháp cho ô sửa trực tiếp; và các dòng đang mở bảng sửa
  const [drafts, setDrafts] = useState({})
  const [tableOpen, setTableOpen] = useState(() => new Set())
  // Lưu JSON nhiều file: tên gốc mặc định theo ngày (dd) + thư mục lưu
  const [jsonPrefix, setJsonPrefix] = useState(() => String(new Date().getDate()).padStart(2, '0'))
  const [jsonFolder, setJsonFolder] = useState('')
  const [savingJson, setSavingJson] = useState(false)
  // Tên file JSON cho từng kết quả — mặc định tự render, user sửa được (ghi đè)
  const [jsonNames, setJsonNames] = useState({})
  // Các dòng đang chạy "phân tích lại" riêng lẻ
  const [rerunKeys, setRerunKeys] = useState(() => new Set())
  // ===== Tìm kiếm clip từ channel =====
  const [channelRows, setChannelRows] = useState([newChan()])
  const [searchSort, setSearchSort] = useState('views')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState({})
  const [searching, setSearching] = useState(false)
  const [appBlock, setAppBlock] = useState(null) // {block, title, message} khi bị khóa từ xa
  // Theo dõi TikTok: danh sách kênh + lịch sử lưu ở server (config), giao diện chỉ hiển thị
  const [ttRows, setTtRows] = useState(() => [newTtRow()]) // mỗi link một ô để validate từng dòng
  const [ttItems, setTtItems] = useState([])
  const [ttLoaded, setTtLoaded] = useState(false)
  const [ttBusy, setTtBusy] = useState(() => new Set()) // handle đang kiểm tra ('__new__' = đang thêm kênh mới)
  const [ttErrors, setTtErrors] = useState({}) // handle -> lỗi lần kiểm tra gần nhất
  const [ttHistOpen, setTtHistOpen] = useState(() => new Set())
  const [ttUnlocked, setTtUnlocked] = useState(null) // null = chưa hỏi server; false = đang khóa; true = đã mở
  const [ttPass, setTtPass] = useState('')
  const [ttPassShow, setTtPassShow] = useState(false)
  const [ttPassErr, setTtPassErr] = useState('')
  const [ttProgress, setTtProgress] = useState(null) // { label, done, total, current }
  const [ttAddErrors, setTtAddErrors] = useState([]) // lỗi khi thêm hàng loạt: [{ input, message }]
  const pollRef = useRef(null)

  const refresh = async () => {
    const d = await fetch(`${API}/api/jobs`).then(r => r.json())
    // Response chặn (killswitch 403) hoặc lỗi không có mảng jobs -> đừng ghi đè thành undefined
    // (jobs.some() sẽ nổ và làm trắng cả app trước khi màn khóa kịp hiện).
    if (!Array.isArray(d.jobs)) return d
    setJobs(d.jobs)
    setPaused(!!d.paused)
    return d
  }

  useEffect(() => {
    // Khóa từ xa: đọc trạng thái trước tiên. block=true -> app khóa toàn bộ, chỉ hiện thông báo.
    fetch(`${API}/api/app-control`).then(r => r.json()).then(d => { if (d.block) setAppBlock(d) }).catch(() => {})
    fetch(`${API}/api/defaults`)
      .then(r => r.json())
      .then(d => {
        setDefaultFolder(d.folder)
        setJsonFolder(prev => prev || d.folder)
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

  const clearDraft = key => setDrafts(d => { const n = { ...d }; delete n[key]; return n })
  const toggleTable = key => setTableOpen(s2 => { const n = new Set(s2); n.has(key) ? n.delete(key) : n.add(key); return n })
  // Sửa số đoạn mong muốn của một dòng (null = AI tự đề xuất)
  const setSegCount = (key, val) => updateRow(key, { segCount: val })

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
        // Tạo object dòng MỚI, không sửa thẳng object cũ — nếu không, React StrictMode
        // gọi updater 2 lần sẽ thấy dòng đầu đã có link rồi append lại → nhân đôi link đầu.
        const out = rs.map(r => ({ ...r }))
        let i = 0
        for (const r of out) {
          if (!r.url.trim() && i < urls.length) r.url = urls[i++]
        }
        while (i < urls.length && out.length < rowLimit) out.push({ ...newRow(defaultFolder), url: urls[i++] })
        if (i < urls.length) {
          alert(`Tab này nhận tối đa ${rowLimit} link mỗi lần — đã lấy ${out.length} link đầu.`)
        }
        return out
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
  // Ghi thẳng nhiều/1 file JSON vào thư mục đã chọn (không mở hộp thoại "Save as")
  const writeJsonFiles = async (items, overwrite = false) => {
    const res = await fetch(`${API}/api/save-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: jsonFolder, items, overwrite }),
    }).then(r => r.json())
    return res
  }

  // Tên file JSON của một kết quả: ưu tiên tên user đã sửa, không thì tự render <prefix>-<stt>
  const jsonNameFor = (key, stt) =>
    jsonNames[key] ?? ((jsonPrefix.trim() || String(new Date().getDate()).padStart(2, '0')) + '-' + String(stt).padStart(2, '0'))

  // Lưu — nếu thư mục đã có file cùng tên thì HỎI trước, đổi tên hoặc ghi đè (tránh đè mất data)
  const doSaveJson = async (items, label) => {
    let res = await writeJsonFiles(items, false)
    if (res.conflict) {
      const ok = confirm(
        'Thư mục lưu đã có sẵn ' + res.conflicts.length + ' file cùng tên:\n' +
        res.conflicts.slice(0, 10).join('\n') + (res.conflicts.length > 10 ? '\n...' : '') +
        '\n\nGhi đè lên file cũ? (Bấm Hủy để đổi tên rồi lưu lại — tránh mất dữ liệu lần trước)'
      )
      if (!ok) return
      res = await writeJsonFiles(items, true)
    }
    if (res.ok) alert('Đã lưu ' + res.saved.length + ' file JSON vào:\n' + res.folder)
    else alert('Lỗi lưu JSON: ' + res.message)
  }

  // Lưu riêng 1 kết quả — dùng tên đang hiển thị (đã sửa hoặc tự render)
  const saveOneJson = async r => {
    const ready = rows.filter(x => analysis[x.key]?.status === 'ready')
    const stt = ready.findIndex(x => x.key === r.key) + 1 || 1
    await doSaveJson([{
      filename: jsonNameFor(r.key, stt),
      json: segmentsToJson(r.url, analysis[r.key].name, analysis[r.key].segments),
    }])
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
    if (!settings) return true
    // Cần ít nhất một nguồn: cookie YouTube (ưu tiên) hoặc Gemini API key
    if (settings.hasYoutubeCookie || settings.hasGeminiKey) return true
    const why = settings.configError ? settings.configError + '\n\n' : ''
    alert(why + 'Chưa có nguồn phân tích. Dán cookie YouTube (miễn phí token) HOẶC nhập Gemini API key trong Cài đặt ⚙️.')
    setSettingsOpen(true)
    return false
  }

  const pickJsonFolder = async () => {
    const d = await fetch(API + '/api/pick-folder').then(r => r.json())
    if (d.folder) setJsonFolder(d.folder)
  }

  // Lưu mỗi kết quả thành 1 file JSON riêng, tên <prefix>-01, <prefix>-02...
  const saveAllJson = async () => {
    const ready = rows.filter(r => analysis[r.key]?.status === 'ready')
    if (!ready.length) return
    const items = ready.map((r, i) => ({
      filename: jsonNameFor(r.key, i + 1),
      json: segmentsToJson(r.url, analysis[r.key].name, analysis[r.key].segments),
    }))
    setSavingJson(true)
    try {
      await doSaveJson(items)
    } finally {
      setSavingJson(false)
    }
  }

  // Xóa toàn bộ kết quả phân tích (link vẫn giữ). Đang xử lý thì cảnh báo.
  const clearAllAnalysis = () => {
    const busy = analyzingCount > 0 || hasRunning
    const msg = busy
      ? 'ĐANG XỬ LÝ! Xóa hết kết quả bây giờ? Các video đang phân tích/tải sẽ mất kết quả trả về.'
      : 'Xóa tất cả kết quả phân tích? (Link vẫn giữ nguyên trong danh sách)'
    if (!confirm(msg)) return
    setAnalysis({})
    setDrafts({})
    setTableOpen(new Set())
    setJsonNames({})
  }

  const addChannel = () => setChannelRows(cs => [...cs, newChan()])
  const removeChannel = key => setChannelRows(cs => (cs.length === 1 ? cs : cs.filter(c => c.key !== key)))
  const updateChannel = (key, url) => setChannelRows(cs => cs.map(c => (c.key === key ? { ...c, url } : c)))

  const validChannels = channelRows.filter(c => isChannelUrl(c.url))
  const runSearch = async () => {
    if (settings && !settings.hasGeminiKey) {
      alert('Tìm kiếm clip cần Gemini API key (không dùng cookie). Vào Cài đặt ⚙️ nhập key.')
      setSettingsOpen(true)
      return
    }
    const targets = channelRows.filter(c => isChannelUrl(c.url))
    if (!targets.length) return
    setSearching(true)
    setSearchResults(rs => { const n = { ...rs }; targets.forEach(c => { n[c.key] = { status: 'searching', url: c.url } }); return n })
    await Promise.all(targets.map(async c => {
      try {
        const res = await fetch(API + '/api/channel-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: c.url, sortBy: searchSort, keyword: searchKeyword.trim() || undefined }),
        }).then(r => r.json())
        if (res.ok) setSearchResults(rs => ({ ...rs, [c.key]: { status: 'done', url: c.url, ...res, selected: new Set() } }))
        else setSearchResults(rs => ({ ...rs, [c.key]: { status: 'error', url: c.url, message: res.message } }))
      } catch (e) {
        setSearchResults(rs => ({ ...rs, [c.key]: { status: 'error', url: c.url, message: e?.message || String(e) } }))
      }
    }))
    setSearching(false)
  }

  const toggleSearchVideo = (key, url) => setSearchResults(rs => {
    const r = rs[key]; if (!r) return rs
    const sel = new Set(r.selected); sel.has(url) ? sel.delete(url) : sel.add(url)
    return { ...rs, [key]: { ...r, selected: sel } }
  })
  const toggleSearchAll = (key, urls) => setSearchResults(rs => {
    const r = rs[key]; if (!r) return rs
    const all = urls.every(u => r.selected.has(u))
    return { ...rs, [key]: { ...r, selected: new Set(all ? [] : urls) } }
  })
  const copyUrls = async (tag, urls) => {
    if (!urls.length) return
    try { await navigator.clipboard.writeText(urls.join('\n')); setCopiedKey(tag); setTimeout(() => setCopiedKey(k => (k === tag ? null : k)), 2000) }
    catch { alert(urls.join('\n')) }
  }
  // Đưa link sang tab Phân tích (điền vào danh sách link, đổi tab)
  const sendToAnalyze = urls => {
    if (!urls.length) return
    let over = false
    setRows(rs => {
      const seen = new Set(rs.map(r => parseVideoId(r.url)).filter(Boolean))
      const fresh = []
      for (const u of urls) { const id = parseVideoId(u); if (!id || seen.has(id)) continue; seen.add(id); fresh.push(u) }
      const out = rs.map(r => ({ ...r }))
      let i = 0
      for (const r of out) if (!r.url.trim() && i < fresh.length) r.url = fresh[i++]
      while (i < fresh.length && out.length < rowLimit) out.push({ ...newRow(defaultFolder), url: fresh[i++] })
      if (i < fresh.length) over = true
      return out
    })
    setMode('analyze')
    if (over) setTimeout(() => alert('Tab Phân tích tối đa ' + rowLimit + ' link — đã đưa ' + rowLimit + ' link đầu, phần còn lại lưu/để dành nhé.'), 50)
  }

  // Lưu danh sách video ra file .txt — KHÔNG lưu trong app (refresh/tắt app là mất hết state,
  // đây là nơi duy nhất giữ lại được). Mỗi lần bấm đều hỏi thư mục lưu bằng hộp thoại native
  // của Windows; trùng tên file thì hỏi ghi đè để không mất bản cũ.
  const pad2 = n => String(n).padStart(2, '0')
  const ddmmyyyy = () => {
    const d = new Date()
    return pad2(d.getDate()) + pad2(d.getMonth() + 1) + d.getFullYear()
  }
  const doSaveText = async (folder, filename, content) => {
    let res = await fetch(`${API}/api/save-text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, filename, content }),
    }).then(r => r.json())
    if (res.conflict) {
      const ok = confirm('Thư mục đã có sẵn file "' + res.conflicts[0] + '".\n\nGhi đè lên file cũ? (Hủy để chọn thư mục khác)')
      if (!ok) return null
      res = await fetch(`${API}/api/save-text`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, filename, content, overwrite: true }),
      }).then(r => r.json())
    }
    return res
  }
  const exportVideoListTxt = async (channelResult, videos) => {
    if (!videos.length) return
    const d = await fetch(`${API}/api/pick-folder`).then(r => r.json())
    if (!d.folder) return // người dùng bấm Hủy trên hộp thoại chọn thư mục
    const title = channelResult.channelName || channelResult.url || 'kenh'
    const filename = `list videos của ${title} -${ddmmyyyy()}`
    const content = videos.map(v => (v.title ? v.title + '\n' : '') + v.url).join('\n\n')
    const res = await doSaveText(d.folder, filename, content)
    if (!res) return
    if (res.ok) alert('Đã lưu: ' + res.saved + '\n' + res.folder)
    else alert('Lỗi lưu file: ' + res.message)
  }

  // ===== Theo dõi follow kênh TikTok =====
  const ttToday = () => {
    const d = new Date()
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  }
  const ttSetBusy = (handle, on) => setTtBusy(s => { const n = new Set(s); on ? n.add(handle) : n.delete(handle); return n })
  const ttUpsert = item => setTtItems(list => {
    const i = list.findIndex(x => x.handle === item.handle)
    if (i < 0) return [...list, item]
    const out = [...list]; out[i] = item; return out
  })
  const loadTikTok = async () => {
    try {
      const d = await fetch(`${API}/api/tiktok/tracked`).then(r => r.json())
      if (d.ok) setTtItems(d.items || [])
      return d.items || []
    } catch { return [] } finally { setTtLoaded(true) }
  }
  // Kiểm tra 1 kênh (thêm mới hoặc cập nhật). Trả { ok } hoặc { ok:false, message }.
  const checkTikTok = async (urlOrHandle, busyKey) => {
    const url = normalizeTikTokInput(urlOrHandle)
    const key = busyKey || tiktokHandle(url) || '__new__'
    ttSetBusy(key, true)
    setTtErrors(e => { const n = { ...e }; delete n[key]; return n })
    try {
      const res = await fetch(`${API}/api/tiktok/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      })
      const d = await res.json().catch(() => ({}))
      if (d.locked) setTtUnlocked(false)
      if (!d.ok) throw new Error(d.message || ('HTTP ' + res.status))
      ttUpsert(d.item)
      return { ok: true }
    } catch (e) {
      const message = e?.message || String(e)
      setTtErrors(er => ({ ...er, [key]: message }))
      return { ok: false, message }
    } finally {
      ttSetBusy(key, false)
    }
  }
  const ttProgressDone = total => {
    setTtProgress({ label: 'Xong', done: total, total, current: '' })
    setTimeout(() => setTtProgress(p => (p && p.label === 'Xong' ? null : p)), 1800)
  }
  // ----- Ô nhập: mỗi link một dòng, validate từng dòng -----
  const addTtRow = () => setTtRows(rs => [...rs, newTtRow()])
  const removeTtRow = key => setTtRows(rs => (rs.length === 1 ? rs : rs.filter(r => r.key !== key)))
  const updateTtRow = (key, url) => setTtRows(rs => rs.map(r => (r.key === key ? { ...r, url } : r)))
  // Điền các link vào ô trống trước (từ ô `fromKey` nếu có), thiếu thì thêm ô mới. Tạo object mới, không mutate
  // (StrictMode gọi updater 2 lần — mutate là bị double).
  const fillTtRows = (urls, fromKey) => setTtRows(rs => {
    const out = rs.map(r => ({ ...r }))
    const start = fromKey ? Math.max(0, out.findIndex(r => r.key === fromKey)) : 0
    let i = 0
    for (let k = start; k < out.length && i < urls.length; k++) {
      if (!out[k].url.trim() || out[k].key === fromKey) out[k].url = urls[i++]
    }
    while (i < urls.length) out.push({ ...newTtRow(), url: urls[i++] })
    return out
  })
  // Trạng thái từng dòng: empty | bad (không phải link kênh) | dup (trùng dòng trên) | tracked (đã theo dõi) | ok
  const ttRowInfo = (row, idx) => {
    const raw = row.url.trim()
    if (!raw) return { state: 'empty' }
    const url = normalizeTikTokInput(raw)
    if (!isTikTokUrl(url)) return { state: 'bad' }
    const handle = tiktokHandle(url)
    const firstIdx = ttRows.findIndex(r => {
      const u = normalizeTikTokInput(r.url.trim())
      return r.url.trim() && isTikTokUrl(u) && tiktokHandle(u) === handle
    })
    if (firstIdx !== idx) return { state: 'dup', handle }
    if (ttItems.some(x => x.handle === handle)) return { state: 'tracked', handle }
    return { state: 'ok', handle, url: tiktokProfileUrl(handle) }
  }
  // Dán một đoạn nhiều link vào 1 ô -> tự tách ra từng ô
  const onTtPaste = (e, key) => {
    const text = e.clipboardData?.getData('text') || ''
    const { urls } = parseTikTokInputs(text)
    if (urls.length <= 1) return // dán 1 link thì để input xử lý bình thường
    e.preventDefault()
    fillTtRows(urls, key)
  }
  const pasteTikTok = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const { urls } = parseTikTokInputs(text)
      if (!urls.length) { alert('Clipboard không có link kênh TikTok nào (dạng tiktok.com/@ten_kenh)'); return }
      fillTtRows(urls)
    } catch { alert('Không đọc được clipboard') }
  }
  // Theo dõi các dòng hợp lệ (bỏ qua dòng sai/trùng/đã theo dõi — đã báo đỏ tại dòng) — chạy lần lượt,
  // có thanh tiến trình. Dòng thành công được gỡ khỏi ô nhập, dòng lỗi giữ lại để sửa/thử lại.
  const addTikTok = async () => {
    const todo = ttRows.map((row, i) => ({ row, info: ttRowInfo(row, i) })).filter(x => x.info.state === 'ok')
    if (!todo.length) { alert('Chưa có link kênh hợp lệ nào để theo dõi — dòng sai / trùng / đã theo dõi đều bị bỏ qua (xem báo đỏ ở từng dòng)'); return }
    ttSetBusy('__new__', true)
    const doneKeys = new Set()
    const errs = []
    try {
      for (let i = 0; i < todo.length; i++) {
        const { row, info } = todo[i]
        setTtProgress({ label: 'Đang thêm', done: i, total: todo.length, current: '@' + info.handle })
        const r = await checkTikTok(info.url, info.handle)
        if (r.ok) doneKeys.add(row.key)
        else { errs.push({ input: '@' + info.handle, message: r.message }); setTtAddErrors([...errs]) }
      }
      ttProgressDone(todo.length)
    } finally {
      ttSetBusy('__new__', false)
    }
    setTtAddErrors(errs)
    setTtRows(rs => { const left = rs.filter(r => !doneKeys.has(r.key)); return left.length ? left : [newTtRow()] })
  }
  // Khóa lại tab (kiểm tra dialog / trước khi đưa máy cho người khác)
  const ttLock = async () => {
    if (!confirm('Khóa lại tab TikTok? Lần vào tab sau sẽ phải nhập mật khẩu.')) return
    await fetch(`${API}/api/tiktok/lock`, { method: 'POST' }).catch(() => {})
    setTtUnlocked(false)
  }
  // Cập nhật lần lượt (không song song để TikTok không nghi ngờ), có thanh tiến trình
  const refreshTikTok = async items => {
    if (!items.length) return
    for (let i = 0; i < items.length; i++) {
      setTtProgress({ label: 'Đang cập nhật', done: i, total: items.length, current: '@' + items[i].handle })
      await checkTikTok(items[i].url, items[i].handle)
    }
    ttProgressDone(items.length)
  }
  // Khóa tính năng: hỏi server đã mở chưa; mở bằng mật khẩu (server kiểm tra, nhớ trên máy)
  const ttCheckStatus = async () => {
    try {
      const d = await fetch(`${API}/api/tiktok/status`).then(r => r.json())
      setTtUnlocked(Boolean(d.unlocked))
    } catch { setTtUnlocked(false) }
  }
  const ttUnlock = async () => {
    if (!ttPass) return
    setTtPassErr('')
    const d = await fetch(`${API}/api/tiktok/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ttPass }),
    }).then(r => r.json()).catch(() => ({}))
    if (d.ok) { setTtUnlocked(true); setTtPass('') } else setTtPassErr(d.message || 'Sai mật khẩu')
  }
  const removeTikTok = async item => {
    if (!confirm('Bỏ theo dõi @' + item.handle + '? Lịch sử follow đã lưu của kênh này sẽ bị xóa.')) return
    const d = await fetch(`${API}/api/tiktok/remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: item.handle }),
    }).then(r => r.json()).catch(() => ({}))
    if (d.ok) setTtItems(d.items || [])
  }
  const toggleTtHist = handle => setTtHistOpen(s => { const n = new Set(s); n.has(handle) ? n.delete(handle) : n.add(handle); return n })
  const fmtNum = n => (n == null ? '—' : Number(n).toLocaleString('vi'))
  const fmtShort = n => {
    if (n == null) return '—'
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K'
    return String(n)
  }
  const fmtDelta = n => (n == null ? '' : n > 0 ? '+' + fmtNum(n) : n < 0 ? '−' + fmtNum(-n) : '0')
  const deltaClass = n => (n == null || n === 0 ? 'flat' : n > 0 ? 'up' : 'down')
  const fmtWhen = ts => {
    if (!ts) return ''
    const d = new Date(ts)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' ' + pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1)
  }
  const fmtDay = day => (day ? day.slice(8, 10) + '/' + day.slice(5, 7) : '')

  // Mở tab TikTok lần đầu trong phiên: nạp danh sách, rồi tự cập nhật những kênh chưa có mốc hôm nay
  // (đúng nghĩa "hôm sau mở app lên là thấy tăng/giảm", không phải bấm từng cái).
  useEffect(() => {
    if (mode !== 'tiktok') return
    if (ttUnlocked === null) { ttCheckStatus(); return } // chưa biết khóa/mở -> hỏi server trước
    if (!ttUnlocked || ttLoaded) return
    let cancelled = false
    loadTikTok().then(items => {
      if (cancelled) return
      const today = ttToday()
      refreshTikTok(items.filter(it => it.latest?.day !== today))
    })
    return () => { cancelled = true }
  }, [mode, ttUnlocked, ttLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const workers = Array.from({ length: Math.min(10, pending.length) }, async () => {
      while (pending.length) {
        const r = pending.shift()
        patchAnalysis(r.key, { status: 'analyzing', error: '' })
        try {
          const res = await fetch(`${API}/api/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: r.url, source: 'app', prompt: promptOverride || undefined, segCount: r.segCount || undefined }),
          })
          const d = await res.json().catch(() => ({}))
          if (!res.ok || !d.ok) throw new Error(d.message || `Phân tích thất bại (HTTP ${res.status})`)
          const ready = {
            status: 'ready',
            name: d.name,
            segments: d.segments.map(s => ({ start: secToText(s.start), end: secToText(s.end), title: s.title })),
          }
          patchAnalysis(r.key, ready)
          clearDraft(r.key)
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

  // App không có menu/phím tắt Reload (menu bar bị ẩn) nên đây là cách duy nhất "làm mới"
  // mà không phải tắt hẳn app. Backend + job đang chạy KHÔNG bị ảnh hưởng (server sống độc
  // lập với giao diện) — chỉ có state trong React (link, kết quả) là mất, nên cảnh báo trước.
  const requestReload = () => {
    const busy = hasRunning || analyzingCount > 0 || searching
    const hasUnsavedData = Object.keys(analysis).length > 0 || Object.keys(searchResults).length > 0
    if (busy || hasUnsavedData) {
      const msg = busy
        ? 'ĐANG XỬ LÝ (tải/cắt/phân tích/tìm kiếm)! Làm mới giao diện sẽ mất mọi kết quả CHƯA LƯU đang hiển thị (tiến trình tải/cắt trên máy vẫn tiếp tục chạy). Vẫn làm mới?'
        : 'Đang có kết quả phân tích/tìm kiếm CHƯA LƯU. Làm mới giao diện sẽ MẤT HẾT, không khôi phục lại được. Vẫn làm mới?'
      if (!confirm(msg)) return
    }
    window.location.reload()
  }

  // Khóa từ xa: chặn toàn bộ giao diện, chỉ hiện thông báo (không tab, không chức năng nào)
  if (appBlock?.block) {
    return (
      <div className="app">
        <div className="overlay">
          <div className="overlay-card">
            <div className="overlay-emoji">🔒</div>
            <h3>{appBlock.title || 'Công cụ tạm ngừng sử dụng'}</h3>
            <p>{appBlock.message || 'Công cụ đang tạm ngừng. Vui lòng liên hệ quản trị.'}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="hero">
        <h1><img className="logo-img" src={import.meta.env.BASE_URL + 'logo.png'} alt="logo" />Youtube<span className="grad">Download Tool</span></h1>
        <p className="hint">
          {mode === 'analyze'
            ? 'Dán link → Phân tích → nhận text kết quả cắt → Copy / Lưu .txt. Muốn cắt thì qua tab Cắt clip 📋'
            : mode === 'tiktok'
              ? 'Dán link kênh TikTok → Theo dõi. Mỗi lần mở app bấm Cập nhật để xem follow tăng/giảm so với hôm trước 📈'
              : 'Link dùng chung với tab Phân tích. Chọn nguồn mốc cắt → bấm Phân tích để xem/sửa mốc, hoặc Cắt để chạy luôn ✂️'}
        </p>
        <div className="mode-tabs">
          <button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}>🔎 Tìm kiếm clip</button>
          <button className={mode === 'analyze' ? 'active' : ''} onClick={() => setMode('analyze')}>🔍 Phân tích</button>
          <button className={mode === 'cut' ? 'active' : ''} onClick={() => setMode('cut')}>✂️ Cắt clip</button>
          <button className={mode === 'tiktok' ? 'active' : ''} onClick={() => setMode('tiktok')}>📈 TikTok</button>
          <button className="btn-icon" title="Làm mới giao diện (app không có menu Reload sẵn)" onClick={requestReload}>🔄</button>
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

      {settings && ((!settings.hasGeminiKey && !settings.hasYoutubeCookie) || settings.configError) && (
        <div className="error-banner">
          <span className="warning-icon">🔑</span>
          <span>
            {settings.configError
              ? settings.configError
              : 'Chưa có nguồn phân tích. Dán cookie YouTube (miễn phí token) hoặc nhập Gemini API key — bấm nút bên cạnh để mở Cài đặt.'}
          </span>
          <button className="btn-reset" onClick={() => setSettingsOpen(true)}>⚙️ Mở Cài đặt</button>
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
          probeUrl={usableRows[0]?.url || ''}
          onClose={() => {
            setSettingsOpen(false)
            fetch(API + '/api/settings').then(r => r.json()).then(setSettings).catch(() => {})
          }}
          onSaved={s => {
            setSettings(s)
            setSettingsOpen(false)
          }}
        />
      )}

      {mode !== 'search' && mode !== 'tiktok' && (
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
            {mode === 'analyze' && !urlInvalid && !urlDup && r.url.trim() && (
              <SegCountControl value={r.segCount} onChange={v => setSegCount(r.key, v)} disabled={hasRunning || analyzingCount > 0} />
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
          <span className="row-count">{rows.length} link</span>
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
      )}

      {mode === 'search' && (
        <>
        <div className={'card' + (searching ? ' locked' : '')}>
          {searching && <div className="locked-note">🔎 Đang tìm — chờ AI quét kênh xong nhé</div>}
          <div className="rows">
            {channelRows.map((c, i) => {
              const bad = c.url.trim() !== '' && !isChannelUrl(c.url)
              return (
                <div className="row-wrap" key={c.key}>
                  <div className="row">
                    <span className="row-num">{i + 1}</span>
                    <input className={'url' + (bad ? ' invalid' : '')}
                      placeholder="Link channel: youtube.com/channel/... hoặc youtube.com/@ten"
                      value={c.url} disabled={searching}
                      onChange={e => updateChannel(c.key, e.target.value)} />
                    <button className="btn-icon" title="Xóa" disabled={channelRows.length === 1 || searching} onClick={() => removeChannel(c.key)}>✕</button>
                  </div>
                  {bad && <div className="row-error">⚠ Không phải link channel — cần dạng youtube.com/channel/... hoặc youtube.com/@ten</div>}
                </div>
              )
            })}
          </div>
          <div className="actions">
            <button onClick={addChannel} disabled={searching}>＋ Thêm channel</button>
          </div>
          <div className="search-opts">
            <span className="json-lbl">Tiêu chí:</span>
            <label className="set-check"><input type="radio" name="ssort" checked={searchSort === 'views'} onChange={() => setSearchSort('views')} disabled={searching} /><span>Theo lượt xem</span></label>
            <label className="set-check"><input type="radio" name="ssort" checked={searchSort === 'date'} onChange={() => setSearchSort('date')} disabled={searching} /><span>Theo ngày đăng</span></label>
            <label className="set-check"><input type="radio" name="ssort" checked={searchSort === 'episode'} onChange={() => setSearchSort('episode')} disabled={searching} /><span>Theo tập phim</span></label>
          </div>
          <div className="search-title-row">
            <label className="json-lbl" htmlFor="search-title">Title video cần tìm:</label>
            <input id="search-title" className="set-input search-kw" placeholder="Tên phim cần tìm (tùy chọn) — vd Đấu La Đại Lục" value={searchKeyword} onChange={e => setSearchKeyword(e.target.value)} disabled={searching} />
          </div>
          <div className="actions">
            <button className="primary" onClick={runSearch} disabled={searching || validChannels.length === 0} style={{ marginLeft: 'auto' }}>
              {searching ? '🔎 Đang tìm...' : '🔎 Tìm kiếm (' + validChannels.length + ')'}
            </button>
          </div>
        </div>

        <div className="search-res">
          {channelRows.map(c => {
            const r = searchResults[c.key]
            if (!r) return null
            const urls = (r.videos || []).map(v => v.url)
            return (
              <div className={'sr-card' + (r.status === 'error' || r.suitable === false ? ' bad' : '')} key={c.key}>
                <div className="sr-head">
                  <span className="sr-name">{r.channelName || r.url}</span>
                  {r.status === 'searching' && <span className="sr-reason">🔎 Đang quét kênh...</span>}
                  {r.status === 'error' && <span className="sr-reason" style={{ color: '#fda4af' }}>❌ {r.message}</span>}
                  {r.status === 'done' && <span className="sr-reason">{r.suitable ? ('✓ ' + urls.length + ' clip (quét ' + r.totalScanned + ' video)') : ('⚠ ' + (r.reason || 'Không phù hợp'))}</span>}
                </div>
                {r.status === 'done' && urls.length > 0 && (
                  <>
                    <div className="sr-tools">
                      <button onClick={() => toggleSearchAll(c.key, urls)}>{urls.every(u => r.selected.has(u)) ? 'Bỏ chọn hết' : 'Chọn hết'}</button>
                      <button onClick={() => copyUrls('sc-' + c.key, r.selected.size ? [...r.selected] : urls)}>{copiedKey === ('sc-' + c.key) ? '✓ Đã copy!' : ('📋 Copy ' + (r.selected.size ? 'đã chọn (' + r.selected.size + ')' : 'tất cả'))}</button>
                      <button onClick={() => exportVideoListTxt(r, r.videos.filter(v => !r.selected.size || r.selected.has(v.url)))}>💾 Lưu file .txt ({r.selected.size || urls.length})</button>
                      <button className="primary" onClick={() => sendToAnalyze(r.selected.size ? [...r.selected] : urls)}>➡ Đưa sang Phân tích ({r.selected.size || urls.length})</button>
                    </div>
                    <div className="sr-list">
                      {r.videos.map(v => (
                        <label className="sr-item" key={v.url}>
                          <input type="checkbox" checked={r.selected.has(v.url)} onChange={() => toggleSearchVideo(c.key, v.url)} />
                          <a href={v.url} target="_blank" rel="noreferrer">{v.title}</a>
                          <span className="sr-views">{v.views ? v.views.toLocaleString('vi') + ' views' : ''}{v.publishedText ? ' · ' + v.publishedText : ''}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
        </>
      )}
      {mode === 'analyze' && rows.some(r => analysis[r.key]) && (
        <div className="analysis">
          {rows.filter(r => analysis[r.key]?.status === 'ready').length >= 1 && (
            <div className="results-tools json-save">
              <span className="json-lbl">Lưu JSON:</span>
              <input
                className="json-name"
                value={jsonPrefix}
                onChange={e => setJsonPrefix(e.target.value)}
                title="Tên gốc — file sẽ là tên-01.json, tên-02.json..."
                placeholder="vd 29"
              />
              <input
                className="json-folder"
                value={jsonFolder}
                onChange={e => setJsonFolder(e.target.value)}
                placeholder="Thư mục lưu"
              />
              <button className="btn-icon" title="Chọn thư mục" onClick={pickJsonFolder}>📁</button>
              <button className="primary" onClick={saveAllJson} disabled={savingJson}>
                {savingJson ? 'Đang lưu...' : '⬇ Lưu tất cả JSON (' + rows.filter(r => analysis[r.key]?.status === 'ready').length + ')'}
              </button>
              <button className="btn-clear-all" onClick={clearAllAnalysis} title="Xóa tất cả kết quả (link vẫn giữ)">🗑 Xóa tất cả</button>
              <button
                onClick={() => copyResult('ALL',
                  rows
                    .filter(r => analysis[r.key]?.status === 'ready')
                    .map(r => segmentsToPipeText(analysis[r.key].name, analysis[r.key].segments))
                    .join('\n\n')
                )}
              >
                {copiedKey === 'ALL' ? '✓ Đã copy tất cả!' : '📋 Copy tất cả (' + rows.filter(r => analysis[r.key]?.status === 'ready').length + ')'}
              </button>
            </div>
          )}
          {rows.filter(r => analysis[r.key]).map(r => {
            const a = analysis[r.key]
            const canonical = a.status === 'ready' ? segmentsToPipeText(a.name, a.segments) : ''
            const pipe = a.status === 'ready' ? (drafts[r.key] ?? canonical) : ''
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
                        title="Lưu kết quả này thành file .json vào thư mục đã chọn"
                        onClick={() => saveOneJson(r)}
                      >⬇ JSON</button>
                      <label className="json-name-lbl">File name
                        <input
                          className="json-name-edit"
                          value={jsonNameFor(r.key, rows.filter(x => analysis[x.key]?.status === 'ready').findIndex(x => x.key === r.key) + 1)}
                          onChange={e => setJsonNames(m => ({ ...m, [r.key]: e.target.value }))}
                          title="Tên file JSON — sửa được"
                          placeholder="tên file"
                        />
                      </label>
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
                  <>
                    <textarea
                      className="pipe-edit"
                      value={pipe}
                      spellCheck={false}
                      onChange={e => {
                        const text = e.target.value
                        setDrafts(d => ({ ...d, [r.key]: text }))
                        const parsed = parseSegmentsText(text)
                        if (parsed.segments.length) patchAnalysis(r.key, { name: parsed.name || a.name, segments: parsed.segments })
                      }}
                    />
                    <div className="result-tools-row">
                      <button className="btn-icon" onClick={() => toggleTable(r.key)}>
                        {tableOpen.has(r.key) ? '⊞ Đóng bảng sửa' : '⊞ Mở bảng sửa'}
                      </button>
                      {drafts[r.key] != null && drafts[r.key] !== canonical && (
                        <button className="btn-icon" title="Về đúng định dạng chuẩn" onClick={() => clearDraft(r.key)}>↺ Chuẩn hóa</button>
                      )}
                      <SegCountControl value={r.segCount} onChange={v => setSegCount(r.key, v)} disabled={rerunKeys.has(r.key)} />
                    </div>
                    {tableOpen.has(r.key) && (
                      <SegmentEditor
                        entry={a}
                        onName={name => { patchAnalysis(r.key, { name }); clearDraft(r.key) }}
                        onSegment={(i, patch) => { updateSegment(r.key, i, patch); clearDraft(r.key) }}
                        onRemove={i => { removeSegment(r.key, i); clearDraft(r.key) }}
                        onAdd={() => { addSegment(r.key); clearDraft(r.key) }}
                      />
                    )}
                  </>
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

      {mode === 'tiktok' && ttUnlocked === false && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="overlay-emoji">🔒</div>
            <h3>Tính năng giới hạn</h3>
            <p>Nhập mật khẩu để dùng tab Theo dõi TikTok. Chỉ cần nhập một lần trên máy này.</p>
            <div className="tt-pass-wrap">
              <input className="set-input tt-pass" type={ttPassShow ? 'text' : 'password'} placeholder="Mật khẩu" autoFocus
                value={ttPass} onChange={e => setTtPass(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') ttUnlock() }} />
              <button type="button" className="tt-pass-eye" title={ttPassShow ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                onClick={() => setTtPassShow(v => !v)}>{ttPassShow ? '🙈' : '👁️'}</button>
            </div>
            {ttPassErr && <div className="row-error">⚠ {ttPassErr}</div>}
            <div className="actions tt-pass-actions">
              <button onClick={() => { setTtPassErr(''); setTtPass(''); setMode('analyze') }}>← Quay lại</button>
              <button className="primary" onClick={ttUnlock} disabled={!ttPass}>🔓 Mở khóa</button>
            </div>
          </div>
        </div>
      )}

      {mode === 'tiktok' && ttUnlocked === true && (
        <>
        <div className={'card' + (ttBusy.has('__new__') ? ' locked' : '')}>
          {ttBusy.has('__new__') && <div className="locked-note">⏳ Đang thêm kênh — chờ đọc xong nhé</div>}
          <div className="rows">
            {ttRows.map((r, i) => {
              const info = ttRowInfo(r, i)
              const invalid = info.state === 'bad' || info.state === 'dup' || info.state === 'tracked'
              return (
                <div className="row-wrap" key={r.key}>
                  <div className="row">
                    <span className="row-num">{i + 1}</span>
                    <input className={'url' + (invalid ? ' invalid' : '')}
                      placeholder="Link kênh TikTok: https://www.tiktok.com/@ten_kenh (hoặc @ten_kenh)"
                      value={r.url} disabled={ttBusy.has('__new__')}
                      onChange={e => updateTtRow(r.key, e.target.value)}
                      onPaste={e => onTtPaste(e, r.key)}
                      onKeyDown={e => { if (e.key === 'Enter' && !ttBusy.has('__new__')) addTikTok() }} />
                    <button className="btn-icon" title="Xóa dòng" disabled={ttRows.length === 1 || ttBusy.has('__new__')} onClick={() => removeTtRow(r.key)}>✕</button>
                  </div>
                  {info.state === 'bad' && <div className="row-error">⚠ Không phải link kênh TikTok — cần dạng tiktok.com/@ten_kenh (link video không tính)</div>}
                  {info.state === 'dup' && <div className="row-error">⚠ Trùng link ở dòng trên (@{info.handle})</div>}
                  {info.state === 'tracked' && <div className="row-error">⚠ Kênh @{info.handle} đã được theo dõi — kết quả ở bên dưới, bấm Cập nhật ở đó nếu cần số mới</div>}
                </div>
              )
            })}
          </div>
          <div className="actions">
            <button onClick={addTtRow} disabled={ttBusy.has('__new__')}>＋ Thêm link</button>
            <button onClick={pasteTikTok} disabled={ttBusy.has('__new__')}>📋 Dán nhiều link</button>
            {ttItems.length > 0 && <button onClick={() => refreshTikTok(ttItems)} disabled={ttBusy.size > 0}>🔄 Cập nhật tất cả ({ttItems.length})</button>}
            <button onClick={ttLock} disabled={ttBusy.size > 0} title="Khóa lại tab — lần vào sau sẽ hỏi mật khẩu">🔒 Khóa lại</button>
            <button className="primary" onClick={addTikTok} disabled={ttBusy.has('__new__') || ttRows.every((r, i) => ttRowInfo(r, i).state !== 'ok')}>
              {ttBusy.has('__new__') ? '⏳ Đang thêm...' : '➕ Theo dõi (' + ttRows.filter((r, i) => ttRowInfo(r, i).state === 'ok').length + ')'}
            </button>
          </div>
          {ttProgress && (
            <div className="tt-progress">
              <div className="bar"><div className="bar-fill" style={{ width: Math.round(100 * ttProgress.done / Math.max(1, ttProgress.total)) + '%' }} /></div>
              <div className="tt-progress-txt">{ttProgress.label} {ttProgress.done}/{ttProgress.total} {ttProgress.current}</div>
            </div>
          )}
          {ttAddErrors.length > 0 && (
            <div className="row-error">{ttAddErrors.map((e, i) => <div key={i}>⚠ {e.input}: {e.message}</div>)}</div>
          )}
          {ttItems.length > 0 && <div className="tt-meta" style={{ marginTop: 8 }}>{ttItems.length} kênh đang theo dõi · mốc lưu theo ngày, so với mốc ngày trước</div>}
        </div>

        <div className="search-res">
          {ttLoaded && ttItems.length === 0 && (
            <div className="sr-card tt-empty">Chưa theo dõi kênh nào. Dán link kênh TikTok ở trên rồi bấm <b>Theo dõi</b> — app sẽ lưu số follow hôm nay, hôm sau mở lại là thấy tăng/giảm.</div>
          )}
          {ttItems.map(it => {
            const busy = ttBusy.has(it.handle)
            const err = ttErrors[it.handle]
            const L = it.latest
            const stale = L && L.day !== ttToday()
            const hist = [...(it.history || [])].reverse()
            return (
              <div className={'sr-card' + (err ? ' bad' : '')} key={it.handle}>
                <div className="tt-card">
                  {it.avatar ? <img className="tt-avatar" src={it.avatar} alt="" referrerPolicy="no-referrer" /> : <div className="tt-avatar ph">🎵</div>}
                  <div>
                    <div className="tt-name">
                      <a href={it.url} target="_blank" rel="noreferrer">{it.nickname || it.handle}</a>
                      {it.verified && <span title="Đã xác minh"> ✓</span>}
                      <span className="tt-handle">@{it.handle}</span>
                    </div>
                    {L ? (
                      <>
                        <div className="tt-stats">
                          <span><b className="tt-follow">{fmtNum(L.followers)}</b> follower
                            {it.delta && (
                              <span className={'tt-delta ' + deltaClass(it.delta.followers)} title={'So với mốc ' + fmtDay(it.previous?.day) + ' (' + fmtNum(it.previous?.followers) + ')'}>
                                {fmtDelta(it.delta.followers)} {it.daysBetween === 1 ? 'so với hôm trước' : 'so với ' + it.daysBetween + ' ngày trước'}
                              </span>
                            )}
                            {!it.delta && <span className="tt-delta flat">mốc đầu — mai so sánh</span>}
                          </span>
                          <span><b>{fmtNum(L.following)}</b> following</span>
                          <span><b>{fmtShort(L.hearts)}</b> tim{it.delta && it.delta.hearts ? <span className={'tt-delta ' + deltaClass(it.delta.hearts)}>{fmtDelta(it.delta.hearts)}</span> : null}</span>
                          <span><b>{fmtNum(L.videos)}</b> video{it.delta && it.delta.videos ? <span className={'tt-delta ' + deltaClass(it.delta.videos)}>{fmtDelta(it.delta.videos)}</span> : null}</span>
                        </div>
                        <div className="tt-meta">
                          {busy ? '⏳ Đang đọc số liệu mới...' : ('Cập nhật lúc ' + fmtWhen(L.at) + (stale ? ' (chưa có mốc hôm nay)' : ''))}
                          {it.first && it.deltaFromFirst != null && (' · từ ' + fmtDay(it.first.day) + ' (' + it.daysFromFirst + ' ngày): ' + fmtDelta(it.deltaFromFirst) + ' follower')}
                        </div>
                      </>
                    ) : (
                      <div className="tt-meta">{busy ? '⏳ Đang đọc số liệu...' : 'Chưa có số liệu'}</div>
                    )}
                    {err && <div className="row-error">⚠ {err}</div>}
                  </div>
                  <div className="tt-tools">
                    <button onClick={() => checkTikTok(it.url, it.handle)} disabled={busy}>{busy ? '⏳' : '🔄 Cập nhật'}</button>
                    <button onClick={() => toggleTtHist(it.handle)} disabled={!hist.length}>{ttHistOpen.has(it.handle) ? '▲ Lịch sử' : '▼ Lịch sử (' + hist.length + ')'}</button>
                    <button className="btn-icon" title="Bỏ theo dõi" onClick={() => removeTikTok(it)}>✕</button>
                  </div>
                </div>
                {ttHistOpen.has(it.handle) && hist.length > 0 && (
                  <div className="tt-hist">
                    <table>
                      <thead><tr><th>Ngày</th><th>Follower</th><th>+/− so ngày trước</th><th>Following</th><th>Tim</th><th>Video</th></tr></thead>
                      <tbody>
                        {hist.map((h, i) => {
                          const prev = hist[i + 1]
                          const d = prev ? h.followers - prev.followers : null
                          return (
                            <tr key={h.day}>
                              <td>{fmtDay(h.day)} <span style={{ color: '#6f7490' }}>{fmtWhen(h.at).slice(0, 5)}</span></td>
                              <td><b style={{ color: '#f1f2f8' }}>{fmtNum(h.followers)}</b></td>
                              <td className={d == null ? '' : deltaClass(d)}>{d == null ? '—' : fmtDelta(d)}</td>
                              <td>{fmtNum(h.following)}</td>
                              <td>{fmtNum(h.hearts)}</td>
                              <td>{fmtNum(h.videos)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        </>
      )}

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

// Chọn số đoạn mong muốn cho một link: AI tự đề xuất, hoặc số cụ thể (2–20).
function SegCountControl({ value, onChange, disabled }) {
  const custom = value != null
  return (
    <div className="segcount">
      <label className="segcount-opt">
        <input type="radio" checked={!custom} onChange={() => onChange(null)} disabled={disabled} />
        <span>AI tự đề xuất</span>
      </label>
      <label className="segcount-opt">
        <input type="radio" checked={custom} onChange={() => onChange(3)} disabled={disabled} />
        <span>Số đoạn cụ thể</span>
      </label>
      {custom && (
        <select
          className="segcount-num"
          value={value}
          disabled={disabled}
          onChange={e => onChange(parseInt(e.target.value, 10))}
        >
          {Array.from({ length: 19 }, (_, i) => i + 2).map(n => (
            <option key={n} value={n}>{n} đoạn</option>
          ))}
        </select>
      )}
    </div>
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

function SettingsModal({ settings, onClose, onSaved, probeUrl }) {
  const [keyDraft, setKeyDraft] = useState('')
  const [clearKeys, setClearKeys] = useState(false)
  const [keyChecks, setKeyChecks] = useState(null)
  const [checkingKeys, setCheckingKeys] = useState(false)
  const [cookieDraft, setCookieDraft] = useState('')
  const [cookieInfo, setCookieInfo] = useState({ has: Boolean(settings?.hasYoutubeCookie), account: settings?.youtubeAccount || '' })
  const [cookieMsg, setCookieMsg] = useState(null)
  const [cookieBusy, setCookieBusy] = useState(false)
  const [probeUrlDraft, setProbeUrlDraft] = useState(probeUrl || '')
  const [probeBusy, setProbeBusy] = useState(false)
  const [probeOut, setProbeOut] = useState('')
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

  // Cookie chỉ đi một chiều lên server local; server không bao giờ trả cookie về
  const submitCookie = async () => {
    setCookieBusy(true)
    setCookieMsg(null)
    try {
      const res = await fetch(API + '/api/youtube-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: cookieDraft }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.message || 'HTTP ' + res.status)
      setCookieInfo({ has: true, account: d.accountName })
      setCookieDraft('')
      setCookieMsg({ ok: true, text: '✓ Đăng nhập OK: ' + d.accountName + ' (' + d.cookieCount + ' cookie)' })
    } catch (e) {
      setCookieMsg({ ok: false, text: e?.message || String(e) })
    } finally {
      setCookieBusy(false)
    }
  }

  const checkCookie = async () => {
    setCookieBusy(true)
    setCookieMsg(null)
    try {
      const d = await fetch(API + '/api/youtube-cookie').then(r => r.json())
      if (d.ok) setCookieInfo({ has: true, account: d.accountName })
      setCookieMsg({ ok: d.ok, text: d.ok ? '✓ Cookie còn sống: ' + d.accountName : d.message })
    } catch (e) {
      setCookieMsg({ ok: false, text: e?.message || String(e) })
    } finally {
      setCookieBusy(false)
    }
  }

  const removeCookie = async () => {
    if (!confirm('Xóa cookie YouTube khỏi máy này?')) return
    await fetch(API + '/api/youtube-cookie', { method: 'DELETE' }).catch(() => {})
    setCookieInfo({ has: false, account: '' })
    setCookieMsg({ ok: true, text: 'Đã xóa cookie' })
  }

  const importCookieFile = e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setCookieDraft(String(reader.result || ''))
    reader.onerror = () => setCookieMsg({ ok: false, text: 'Không đọc được file' })
    reader.readAsText(file)
  }

  // Dò xem tài khoản có thấy panel Hỏi Gemini không — kết quả tóm tắt + file chi tiết trong ask-debug
  const runProbe = async () => {
    setProbeBusy(true)
    setProbeOut('')
    try {
      const res = await fetch(API + '/api/youtube-ask/probe?url=' + encodeURIComponent(probeUrlDraft.trim()))
      const d = await res.json()
      setProbeOut(JSON.stringify(d, null, 2))
    } catch (e) {
      setProbeOut('Lỗi: ' + (e?.message || e))
    } finally {
      setProbeBusy(false)
    }
  }

  // Nhập key từ file .txt — mỗi dòng một key (nhận cả phẩy / khoảng trắng)
  const checkKeys = async () => {
    setCheckingKeys(true)
    setKeyChecks(null)
    try {
      const typed = keyDraft.split(/[\s,]+/).map(k => k.trim()).filter(k => k.length >= 12)
      const res = await fetch(API + '/api/check-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typed.length ? { keys: typed } : {}),
      }).then(r => r.json())
      setKeyChecks(res.results || [])
    } catch (e) {
      setKeyChecks([{ key: '', ok: false, message: e?.message || String(e) }])
    } finally {
      setCheckingKeys(false)
    }
  }

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
      // Xác nhận rõ đang lưu bao nhiêu key — tránh tình huống tưởng đã lưu mà chưa
      const typedKeys = keyDraft.split(/[\s,]+/).map(k => k.trim()).filter(Boolean).length
      if (typedKeys) alert('✓ Đã lưu ' + d.keyCount + ' API key.')
      else if (d.keyCount === 0) alert('⚠ Chưa có API key nào được lưu. Dán key vào ô rồi bấm Lưu lại nhé.')
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
          {(settings?.keyCount > 0 || keyDraft.trim()) && (
            <> <button className="set-reset" onClick={checkKeys} disabled={checkingKeys}>
              {checkingKeys ? 'Đang kiểm tra...' : '🔑 Kiểm tra key'}
            </button></>
          )}
        </p>
        {keyChecks && (
          <ul className="key-checks">
            {keyChecks.map((c, i) => (
              <li key={i} className={c.ok ? 'ok' : 'bad'}>
                {c.ok ? '✓' : '✗'} <code>{c.key || 'key'}</code> — {c.message}
              </li>
            ))}
            {keyChecks.length > 1 && (
              <li className="sum">{keyChecks.filter(c => c.ok).length}/{keyChecks.length} key hợp lệ</li>
            )}
          </ul>
        )}

        <label className="set-label">Model</label>
        <select className="set-input" value={modelDraft} onChange={e => setModelDraft(e.target.value)}>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <label className="set-label">
          YouTube cá nhân — cookie đăng nhập
          {cookieInfo.has && ' (đang dùng: ' + (cookieInfo.account || 'đã đăng nhập') + ')'}
        </label>
        <textarea
          className="set-input set-keys"
          rows={3}
          placeholder={'Dán giá trị header "cookie" từ DevTools (F12 → Network → chọn request bất kỳ tới youtube.com → Request Headers → cookie), hoặc dán nội dung file cookies.txt'}
          value={cookieDraft}
          onChange={e => setCookieDraft(e.target.value)}
        />
        <div className="set-row">
          <label className="set-file" title="File cookies.txt (Netscape) hoặc JSON từ extension">
            📄 Nhập cookies.txt
            <input type="file" accept=".txt,.json,text/plain,application/json" hidden onChange={importCookieFile} />
          </label>
          <button className="set-reset" onClick={submitCookie} disabled={!cookieDraft.trim() || cookieBusy}>
            {cookieBusy ? 'Đang kiểm tra...' : '🔐 Lưu & kiểm tra đăng nhập'}
          </button>
          {cookieInfo.has && <button className="set-reset" onClick={checkCookie} disabled={cookieBusy}>🔄 Kiểm tra lại</button>}
          {cookieInfo.has && <button className="set-reset" onClick={removeCookie} disabled={cookieBusy}>🗑 Xóa cookie</button>}
        </div>
        {cookieMsg && <p className={'set-note' + (cookieMsg.ok ? ' ok' : ' set-error')}>{cookieMsg.text}</p>}
        <p className="set-note">
          Cookie là chìa khóa tài khoản Google của bạn: chỉ lưu trên máy này (file <code>youtube-cookie.txt</code> trong thư mục cấu hình),
          chỉ gửi tới youtube.com, không hiện lại ở đâu. Chỉ dùng cho tài khoản cá nhân, đừng phát cho team.
        </p>
        <div className="set-row">
          <input
            className="set-input"
            placeholder="Link video để dò panel Hỏi Gemini"
            value={probeUrlDraft}
            onChange={e => setProbeUrlDraft(e.target.value)}
          />
          <button className="set-reset" onClick={runProbe} disabled={!cookieInfo.has || !probeUrlDraft.trim() || probeBusy}>
            {probeBusy ? 'Đang dò...' : '🔎 Dò panel Hỏi Gemini'}
          </button>
        </div>
        {probeOut && <pre className="probe-out">{probeOut}</pre>}

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
