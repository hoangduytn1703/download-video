import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSegmentsText, buildPrompt, validatePrompt } from './parse.js'

test('đọc đúng chuỗi pipe thật của team (từ Gemini)', () => {
  const text =
    'Name: El ataque mortal que cambió todo | start_1: 00:46 | end_1: 02:46 | title_bottom_1: Ella enfrenta su peor pesadilla | start_2: 04:34 | end_2: 06:44 | title_bottom_2: El hombre protege su destino fatal | start_3: 07:13 | end_3: 09:23 | title_bottom_3: La tragedia ataca sin piedad hoy'
  const r = parseSegmentsText(text)
  assert.equal(r.name, 'El ataque mortal que cambió todo')
  assert.equal(r.segments.length, 3)
  assert.deepEqual(r.segments[0], { start: '00:46', end: '02:46', title: 'Ella enfrenta su peor pesadilla' })
  assert.deepEqual(r.segments[2], { start: '07:13', end: '09:23', title: 'La tragedia ataca sin piedad hoy' })
})

test('pipe format lộn xộn vẫn đọc được (xuống dòng, hoa thường, khoảng trắng)', () => {
  const text = `Name : Video hay\nSTART_1 : 0:10 | End_1: 3:15 | Title_bottom_1 : P1\nstart_2: 3:22 | end_2: 6:55 | title_bottom_2: P2`
  const r = parseSegmentsText(text)
  assert.equal(r.name, 'Video hay')
  assert.equal(r.segments.length, 2)
  assert.equal(r.segments[1].title, 'P2')
})

test('đọc JSON object và JSON array', () => {
  const obj = parseSegmentsText('{"name":"Test","segments":[{"start":"0:46","end":"2:46","title":"A"}]}')
  assert.equal(obj.name, 'Test')
  assert.equal(obj.segments.length, 1)
  const arr = parseSegmentsText('[{"start":"1:00","end":"4:00","title":"B"},{"start":"5:00","end":"8:00","title":"C"}]')
  assert.equal(arr.segments.length, 2)
})

test('đọc dạng mỗi dòng một đoạn, tiêu đề trước hoặc sau', () => {
  const r = parseSegmentsText(`00:46 - 02:46 Ella enfrenta su peor pesadilla
04:34 – 06:44: El hombre protege
Đoạn kết đỉnh cao 07:13 -> 09:23
1:02:03 đến 1:05:00 Đoạn dài hơn 1 giờ`)
  assert.equal(r.segments.length, 4)
  assert.equal(r.segments[0].title, 'Ella enfrenta su peor pesadilla')
  assert.equal(r.segments[2].title, 'Đoạn kết đỉnh cao')
  assert.deepEqual(r.segments[3], { start: '1:02:03', end: '1:05:00', title: 'Đoạn dài hơn 1 giờ' })
})

test('text rác thì trả rỗng, không nổ', () => {
  assert.equal(parseSegmentsText('').segments.length, 0)
  assert.equal(parseSegmentsText('xin chào không có mốc nào').segments.length, 0)
  assert.equal(parseSegmentsText(null).segments.length, 0)
})

test('đọc bảng markdown (kiểu ChatGPT/Gemini hay trả về)', () => {
  const r = parseSegmentsText(`| Phần | Bắt đầu | Kết thúc | Tiêu đề |
|------|---------|----------|---------|
| P1 | 00:46 | 02:46 | Đoạn mở đầu |
| P2 | 04:34 | 06:44 | Cao trào |`)
  assert.equal(r.segments.length, 2)
  assert.deepEqual(r.segments[0], { start: '00:46', end: '02:46', title: 'Đoạn mở đầu' })
  assert.equal(r.segments[1].title, 'Cao trào')
})

test('tiêu đề không dính ký tự thừa của markdown/ngoặc', () => {
  assert.equal(parseSegmentsText('[00:46 - 02:46] Đoạn mở đầu').segments[0].title, 'Đoạn mở đầu')
  assert.equal(parseSegmentsText('Đoạn mở đầu: 00:46 - 02:46').segments[0].title, 'Đoạn mở đầu')
  assert.equal(parseSegmentsText('- 00:46 - 02:46 Đoạn mở đầu').segments[0].title, 'Đoạn mở đầu')
  assert.equal(parseSegmentsText('P1: 00:46 - 02:46 Đoạn mở đầu').segments[0].title, 'Đoạn mở đầu')
})

test('buildPrompt giữ yêu cầu người dùng và nối quy tắc định dạng', () => {
  const custom = 'Cắt cho tôi 3 đoạn hài hước nhất'
  const withRules = buildPrompt(custom, true)
  assert.ok(withRules.includes(custom), 'phải giữ nguyên yêu cầu người dùng')
  assert.ok(withRules.includes('start_1'), 'phải có quy tắc định dạng')
  const without = buildPrompt(custom, false)
  assert.equal(without, custom)
  // prompt trống thì dùng mặc định
  assert.ok(buildPrompt('', true).includes('start_1'))
})

test('validatePrompt cảnh báo khi prompt tự viết thiếu phần định dạng', () => {
  assert.equal(validatePrompt('Cắt cho tôi 3 đoạn hài hước nhất').ok, false)
  assert.equal(validatePrompt('').ok, false)
  assert.equal(validatePrompt('Trả về start_1: 0:10 | end_1: 3:15').ok, true)
  assert.equal(validatePrompt('Trả về JSON có start và end dạng mm:ss').ok, true)
})

test('prompt mặc định tạo ra text mà parser đọc được', () => {
  // lấy đúng dòng ví dụ trong quy tắc định dạng làm mẫu kết quả AI
  const example = buildPrompt('', true).split('\n').find(l => l.startsWith('Name:'))
  const r = parseSegmentsText(example)
  assert.equal(r.segments.length, 3)
  assert.equal(r.segments[0].start, '0:10')
})
