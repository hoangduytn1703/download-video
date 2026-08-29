import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { parseCookieInput, cookieValue, sapisidHash, authHeaders, extractJsonAfter, findAskCandidates, collectText, parseAskText, encodeYouchatContinuation, decodeYouchatContinuation, findYouchatToken, compactAskPrompt } from './youtube-cookie.js'

test('đọc cookie dạng header copy từ DevTools (có/không tiền tố "cookie:")', () => {
  const r = parseCookieInput('cookie: PREF=f6=40000000; SAPISID=abc123; __Secure-3PAPISID=abc123; SID=xyz')
  assert.equal(cookieValue(r.cookie, 'SAPISID'), 'abc123')
  assert.equal(cookieValue(r.cookie, 'SID'), 'xyz')
  assert.ok(r.names.includes('__Secure-3PAPISID'))
})

test('đọc file cookies.txt kiểu Netscape, chỉ giữ youtube/google, bỏ dòng ghi chú', () => {
  const txt = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t1800000000\tSAPISID\tsap-1',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tsid-1',
    '.google.com\tTRUE\t/\tTRUE\t1800000000\t__Secure-3PAPISID\tsap-1',
    '.example.com\tTRUE\t/\tTRUE\t1800000000\tTRACK\tno',
  ].join('\n')
  const r = parseCookieInput(txt)
  assert.equal(cookieValue(r.cookie, 'SAPISID'), 'sap-1')
  assert.equal(cookieValue(r.cookie, 'SID'), 'sid-1')
  assert.equal(cookieValue(r.cookie, 'TRACK'), '')
})

test('đọc JSON export của extension', () => {
  const r = parseCookieInput(JSON.stringify([
    { name: 'SAPISID', value: 'j1', domain: '.youtube.com' },
    { name: 'OTHER', value: 'x', domain: 'evil.com' },
  ]))
  assert.equal(cookieValue(r.cookie, 'SAPISID'), 'j1')
  assert.equal(cookieValue(r.cookie, 'OTHER'), '')
})

test('cookie thiếu SAPISID (chưa đăng nhập / ẩn danh) thì báo rõ', () => {
  assert.throws(() => parseCookieInput('PREF=abc; YSC=def'), /SAPISID/)
  assert.throws(() => parseCookieInput(''), /trống/)
})

test('SAPISIDHASH = <ts>_sha1("<ts> <SAPISID> <origin>") đúng công thức YouTube web', () => {
  const ts = 1700000000
  const expect = crypto.createHash('sha1').update('1700000000 abc https://www.youtube.com').digest('hex')
  assert.equal(sapisidHash('abc', 'https://www.youtube.com', ts), `${ts}_${expect}`)
})

test('authHeaders ký đủ 3 biến thể và không rò cookie ra ngoài Authorization', () => {
  const h = authHeaders('SAPISID=abc; __Secure-1PAPISID=abc; __Secure-3PAPISID=abc')
  assert.match(h.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40} SAPISID1PHASH \d+_[0-9a-f]{40} SAPISID3PHASH \d+_[0-9a-f]{40}$/)
  assert.ok(!h.Authorization.includes('abc'), 'không được chứa SAPISID thô')
  assert.equal(h['X-Origin'], 'https://www.youtube.com')
  assert.equal(h['X-Goog-AuthUser'], '0')
})

test('extractJsonAfter lấy đúng object dù trong chuỗi có ngoặc', () => {
  const html = 'xx var ytInitialData = {"a":{"b":"}{","c":[1,2]},"d":"x"}; </script>'
  assert.deepEqual(extractJsonAfter(html, 'var ytInitialData = '), { a: { b: '}{', c: [1, 2] }, d: 'x' })
  assert.equal(extractJsonAfter('no marker', 'ytcfg.set('), null)
})

test('findAskCandidates tìm ra panel Hỏi Gemini kèm endpoint để gọi get_panel', () => {
  const data = {
    engagementPanels: [
      { engagementPanelSectionListRenderer: { panelIdentifier: 'engagement-panel-comments-section' } },
      {
        engagementPanelSectionListRenderer: {
          panelIdentifier: 'engagement-panel-ask-youchat',
          content: { sectionListRenderer: { contents: [{ continuationItemRenderer: { continuationEndpoint: { getPanelEndpoint: { panelId: 'engagement-panel-ask-youchat', params: 'AbC' } } } }] } },
        },
      },
    ],
  }
  const c = findAskCandidates(data)
  const hit = c.find(x => x.value === 'engagement-panel-ask-youchat')
  assert.ok(hit, 'phải bắt được panel ask')
  assert.ok(hit.endpoints.some(e => e.type === 'getPanelEndpoint' || e.type === 'continuationEndpoint'))
  assert.ok(!c.some(x => x.value === 'engagement-panel-comments-section'))
})

test('collectText + parseAskText đọc câu trả lời pipe từ response lồng nhau', () => {
  const res = {
    frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { x: { text: { runs: [{ text: 'CUT_RESULT: Name: Prueba | start_1: 0:10 | end_1: 1:40 | title_bottom_1: Hola' }] } } } }] } },
  }
  const r = parseAskText(collectText(res).join('\n'))
  assert.equal(r.name, 'Prueba')
  assert.equal(r.segments.length, 1)
  assert.equal(r.segments[0].title, 'Hola')
})

// Token thật YouTube web gửi khi hỏi trên video Tcz69wYsddU (không chứa thông tin đăng nhập)
const REAL_TOKEN = 'kta-ngtREglQQXlvdWNoYXQaRGtnb3JDQUVTQzFSamVqWTVkMWx6WkdSVklocERTazkzZUhOeFozaGFXVVJHWXprd2JsRnJaRlRNWnpGMlVRJTNEJTNE'

test('giải mã token youchat thật: đúng panel + video id', () => {
  const d = decodeYouchatContinuation(REAL_TOKEN)
  assert.equal(d.panel, 'PAyouchat')
  assert.equal(d.videoId, 'Tcz69wYsddU')
  assert.ok(d.trackingBytes && d.trackingBytes.length > 10)
})

test('encoder dựng lại được ĐÚNG token thật (round-trip byte-by-byte)', () => {
  const d = decodeYouchatContinuation(REAL_TOKEN)
  assert.equal(encodeYouchatContinuation(d.videoId, d.trackingBytes), REAL_TOKEN)
})

test('token tự dựng cho video mới (không blob theo dõi) giải mã lại đúng', () => {
  const tok = encodeYouchatContinuation('W6g1HpKSZx4')
  const d = decodeYouchatContinuation(tok)
  assert.equal(d.panel, 'PAyouchat')
  assert.equal(d.videoId, 'W6g1HpKSZx4')
  assert.equal(d.trackingBytes, null)
})

test('findYouchatToken lấy đúng token youchat trong dữ liệu trang, bỏ token khác', () => {
  const data = {
    a: { continuationCommand: { token: 'Eg0SC2Fub3RoZXJUb2tlbg', request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } },
    b: [{ x: { continuationEndpoint: { continuationCommand: { token: REAL_TOKEN } } } }],
  }
  assert.equal(findYouchatToken(data), REAL_TOKEN)
  assert.equal(findYouchatToken({ nothing: true }), null)
})

test('compactAskPrompt có marker, yêu cầu 1 dòng và đúng ngôn ngữ', () => {
  const p = compactAskPrompt('Tây Ban Nha')
  assert.match(p, /CUT_RESULT:/)
  assert.match(p, /start_1/)
  assert.match(p, /Tây Ban Nha/)
  assert.ok(p.length < 700, 'phải ngắn hơn hẳn prompt đầy đủ')
})
