import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAskText, isClosedBrowserError, isProfileLockError, chromeUserDataDir } from './youtube-ask.js'

test('parseAskText reads CUT_RESULT pipe block and ignores prompt example', () => {
  const page = `Hỏi về video này
${'Name: (tên video) | start_1: 0:10 | end_1: 3:15'}
CUT_RESULT:
Name: Rescate en el mar | start_1: 07:01 | end_1: 08:26 | title_bottom_1: Rescate heroico | start_2: 08:27 | end_2: 09:22 | title_bottom_2: Hombre sobrevive
`
  const r = parseAskText(page)
  assert.equal(r.name, 'Rescate en el mar')
  assert.equal(r.segments.length, 2)
  assert.equal(r.segments[0].start, 421)
  assert.equal(r.segments[1].end, 562)
})

test('closed-browser errors are detected so the next run can relaunch Chrome', () => {
  assert.equal(isClosedBrowserError('browserContext.newPage: Target page, context or browser has been closed'), true)
  assert.equal(isClosedBrowserError('Không thấy nút Hỏi AI trên YouTube'), false)
})

test('Chrome profile-lock errors are detected', () => {
  assert.equal(isProfileLockError('Browser closed: ProcessSingleton'), true)
  assert.equal(isProfileLockError('user data directory is already in use'), true)
  assert.equal(isProfileLockError('Timeout'), false)
})

test('chromeUserDataDir points at this OS Chrome profile folder', () => {
  const dir = chromeUserDataDir()
  assert.match(dir.replace(/\\/g, '/'), /Google\/Chrome/i)
})
