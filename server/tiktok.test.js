import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTikTokUrl, tiktokHandle, tiktokProfileUrl, parseTikTokStats, looksBlocked, appendSnapshot, summarizeHistory, dayKey } from './tiktok.js'

// Cấu trúc rút gọn đúng như trang hồ sơ thật (stats làm tròn, statsV2 chính xác dạng chuỗi)
const page = (userInfo, extra = '') => `<html><head></head><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
  __DEFAULT_SCOPE__: { 'webapp.app-context': { language: 'en' }, 'webapp.user-detail': userInfo },
})}</script>${extra}</body></html>`

const REAL_LIKE = {
  userInfo: {
    user: { id: '74040511300614', uniqueId: 'waineii17', nickname: 'uh,phi🤷🏻‍♀️', avatarThumb: 'https://p16.tiktokcdn.com/a.jpeg', verified: false },
    stats: { followerCount: 55800, followingCount: 44, heart: 3700000, heartCount: 3700000, videoCount: 94 },
    statsV2: { followerCount: '55794', followingCount: '44', heart: '3689671', heartCount: '3689671', videoCount: '94' },
  },
  statusCode: 0,
}

test('isTikTokUrl: chỉ nhận link hồ sơ tiktok.com/@handle', () => {
  assert.equal(isTikTokUrl('https://www.tiktok.com/@waineii17'), true)
  assert.equal(isTikTokUrl('https://www.tiktok.com/@waineii17/'), true)
  assert.equal(isTikTokUrl('https://www.tiktok.com/@wai.ne_ii-17?lang=vi'), true)
  assert.equal(isTikTokUrl('https://tiktok.com/@abc'), true)
  assert.equal(isTikTokUrl('https://www.tiktok.com/@waineii17/video/7300000000'), false, 'link video không phải kênh')
  assert.equal(isTikTokUrl('https://www.tiktok.com/'), false)
  assert.equal(isTikTokUrl('https://www.youtube.com/@abc'), false)
  assert.equal(isTikTokUrl('waineii17'), false)
})

test('tiktokHandle/tiktokProfileUrl chuẩn hóa về chữ thường và link gọn', () => {
  assert.equal(tiktokHandle('https://www.tiktok.com/@WaineII17?lang=vi'), 'waineii17')
  assert.equal(tiktokProfileUrl('waineii17'), 'https://www.tiktok.com/@waineii17')
  assert.equal(tiktokProfileUrl('@x'), 'https://www.tiktok.com/@x')
})

test('parseTikTokStats: ưu tiên statsV2 (số chính xác) thay cho stats làm tròn', () => {
  const r = parseTikTokStats(page(REAL_LIKE))
  assert.equal(r.handle, 'waineii17')
  assert.equal(r.nickname, 'uh,phi🤷🏻‍♀️')
  assert.equal(r.followers, 55794, 'phải là 55794 chứ không phải 55800 làm tròn')
  assert.equal(r.following, 44)
  assert.equal(r.hearts, 3689671)
  assert.equal(r.videos, 94)
  assert.equal(r.verified, false)
})

test('parseTikTokStats: không có statsV2 thì dùng stats', () => {
  const u = { userInfo: { user: { uniqueId: 'abc', nickname: 'ABC' }, stats: { followerCount: 1200, followingCount: 3, heartCount: 50, videoCount: 7 } }, statusCode: 0 }
  const r = parseTikTokStats(page(u))
  assert.equal(r.followers, 1200)
  assert.equal(r.hearts, 50)
})

test('parseTikTokStats: kênh không tồn tại -> lỗi rõ ràng', () => {
  assert.throws(() => parseTikTokStats(page({ statusCode: 10221, statusMsg: "user doesn't exist" })), /Không tìm thấy kênh/)
})

test('parseTikTokStats: trang tường lửa (WAF) -> báo bị chặn, không báo sai cấu trúc', () => {
  const waf = '<!DOCTYPE html><html><head><script id="slardar-config" type="application/json">{"slardarClient":"SlardarWAF","bid":"slardar_us_waf"}</script></head><body></body></html>'
  assert.equal(looksBlocked(waf), true)
  assert.throws(() => parseTikTokStats(waf), /chặn/)
  assert.equal(looksBlocked(page(REAL_LIKE)), false)
})

test('appendSnapshot: mỗi ngày 1 mốc, cập nhật nhiều lần trong ngày thì ghi đè mốc hôm nay', () => {
  const d1 = new Date(2026, 8, 1, 9).getTime()
  const d1b = new Date(2026, 8, 1, 21).getTime()
  const d2 = new Date(2026, 8, 2, 8).getTime()
  let h = appendSnapshot([], { followers: 100, following: 1, hearts: 10, videos: 1 }, d1)
  h = appendSnapshot(h, { followers: 105, following: 1, hearts: 10, videos: 1 }, d1b)
  assert.equal(h.length, 1, 'cùng ngày chỉ giữ 1 mốc')
  assert.equal(h[0].followers, 105)
  h = appendSnapshot(h, { followers: 130, following: 2, hearts: 12, videos: 2 }, d2)
  assert.equal(h.length, 2)
  assert.equal(h[1].day, dayKey(d2))
})

test('summarizeHistory: so với mốc ngày trước, không so với mốc cùng ngày', () => {
  const d1 = new Date(2026, 8, 1, 9).getTime()
  const d3 = new Date(2026, 8, 3, 9).getTime()
  const d3b = new Date(2026, 8, 3, 20).getTime()
  let h = appendSnapshot([], { followers: 100, following: 1, hearts: 10, videos: 1 }, d1)
  h = appendSnapshot(h, { followers: 90, following: 1, hearts: 10, videos: 1 }, d3)
  h = appendSnapshot(h, { followers: 124, following: 2, hearts: 15, videos: 3 }, d3b)
  const s = summarizeHistory(h)
  assert.equal(s.latest.followers, 124)
  assert.equal(s.previous.followers, 100, 'mốc trước phải là ngày 1, không phải mốc sáng ngày 3')
  assert.equal(s.delta.followers, 24)
  assert.equal(s.delta.videos, 2)
  assert.equal(s.daysBetween, 2)
  assert.equal(s.first, null, 'chỉ có 2 ngày thì mốc đầu chính là mốc trước')
})

test('summarizeHistory: 1 mốc duy nhất -> chưa có gì để so', () => {
  const s = summarizeHistory(appendSnapshot([], { followers: 5, following: 0, hearts: 0, videos: 0 }))
  assert.equal(s.latest.followers, 5)
  assert.equal(s.previous, null)
  assert.equal(s.delta, null)
  assert.deepEqual(summarizeHistory([]).latest, null)
})
