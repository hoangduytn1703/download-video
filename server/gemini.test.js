import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTimestamp, formatTimestamp, normalizeSegments, salvageConfig } from './gemini.js'

test('parseTimestamp reads mm:ss, h:mm:ss and plain seconds', () => {
  assert.equal(parseTimestamp('0:10'), 10)
  assert.equal(parseTimestamp('12:42'), 762)
  assert.equal(parseTimestamp('1:02:03'), 3723)
  assert.equal(parseTimestamp(95), 95)
  assert.equal(parseTimestamp('99'), 99)
})

test('parseTimestamp rejects garbage', () => {
  assert.equal(parseTimestamp('abc'), null)
  assert.equal(parseTimestamp('1:99'), null)
  assert.equal(parseTimestamp(''), null)
  assert.equal(parseTimestamp('12,42'), null)
})

test('formatTimestamp pads for ffmpeg', () => {
  assert.equal(formatTimestamp(762), '00:12:42')
  assert.equal(formatTimestamp(3723), '01:02:03')
  assert.equal(formatTimestamp(0), '00:00:00')
})

test('normalizeSegments drops invalid rows and keeps order', () => {
  const segs = normalizeSegments([
    { start: '0:10', end: '3:15', title: 'P1' },
    { start: '5:00', end: '4:00', title: 'nguoc' },
    { start: 'xx', end: '9:00', title: 'hong' },
    { start: '3:22', end: '6:55', title: 'P2' },
  ])
  assert.equal(segs.length, 2)
  assert.deepEqual(segs[0], { start: 10, end: 195, title: 'P1' })
  assert.deepEqual(segs[1], { start: 202, end: 415, title: 'P2' })
})

test('cứu được API key từ file config bị hỏng (ghi dở do tắt máy)', () => {
  // file bị cắt ngang giữa lúc ghi — JSON.parse chết, nhưng key vẫn còn nguyên trong text
  const raw = '{\n  "model": "gemini-3.6-flash",\n  "geminiKey": "AIzaSyTEST-key-1234",\n  "prompt": "prompt team bi cat ngan'
  const cfg = salvageConfig(raw)
  assert.equal(cfg.geminiKey, 'AIzaSyTEST-key-1234')
  assert.equal(cfg.model, 'gemini-3.6-flash')
})

test('file hỏng nặng không cứu được thì trả object rỗng, không ném lỗi', () => {
  assert.deepEqual(salvageConfig('{{{ rac'), {})
  assert.deepEqual(salvageConfig(''), {})
  assert.deepEqual(salvageConfig(null), {})
})

test('không nhận key rỗng khi cứu config', () => {
  assert.deepEqual(salvageConfig('{"geminiKey": "", "model": "gemini-3.6-flash"'), { model: 'gemini-3.6-flash' })
})
