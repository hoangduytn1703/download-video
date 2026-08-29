export function isYouTubeUrl(url) {
  return Boolean(parseVideoId(url))
}

export function parseVideoId(url) {
  try {
    const u = new URL(url.trim())
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0] || ''
      return /^[\w-]{11}$/.test(id) ? id : null
    }
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v') || ''
        return /^[\w-]{11}$/.test(id) ? id : null
      }
      const short = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)
      if (short) return short[1]
    }
    return null
  } catch {
    return null
  }
}

export function sanitizeFilename(name) {
  return (name || '')
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function suggestedFilename(customName, title, ext = 'mp4') {
  const base = sanitizeFilename(customName) || sanitizeFilename(title) || 'video'
  return `${base}.${ext}`
}

// Link channel hợp lệ: /channel/UCxxx, /@handle, /c/ten, /user/ten (kèm hoặc không đuôi tab)
export function isChannelUrl(url) {
  try {
    const u = new URL(String(url).trim())
    const host = u.hostname.replace(/^www\./, '')
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return false
    const p = u.pathname.replace(/\/+$/, '').replace(/\/(videos|featured|streams|shorts|playlists|community)$/i, '')
    return /^\/channel\/UC[\w-]{20,}$/.test(p) || /^\/@[\w.-]+$/.test(p) || /^\/c\/[^/]+$/.test(p) || /^\/user\/[^/]+$/.test(p)
  } catch {
    return false
  }
}
