import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSegmentsText, buildPrompt, validatePrompt, DEFAULT_CUT_PROMPT, jobsToEnqueueAfterAnalyze, cutUiForSource, segmentsToPipeText, segmentsToJson, segCountBlock } from './parse.js'

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
  // tắt quy tắc định dạng vẫn giữ chỉ định ngôn ngữ (2 mối quan tâm độc lập)
  const without = buildPrompt(custom, false)
  assert.ok(without.startsWith(custom))
  assert.match(without, /NGÔN NGỮ ĐẦU RA/)
  assert.ok(!without.includes('start_1'))
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

test('default cut prompt is language-neutral; buildPrompt injects the chosen language', () => {
  assert.doesNotMatch(DEFAULT_CUT_PROMPT, /Tây Ban Nha/i)
  assert.match(buildPrompt('', true), /tiếng Tây Ban Nha/i) // mặc định
  assert.match(buildPrompt('', true, 'Việt'), /tiếng Việt/i)
  assert.doesNotMatch(buildPrompt('', true, 'Việt'), /tiếng Tây Ban Nha/i)
  assert.match(DEFAULT_CUT_PROMPT, /70/)
  assert.match(DEFAULT_CUT_PROMPT, /150|2 phút 30/)
  assert.match(DEFAULT_CUT_PROMPT, /intro/i)
  assert.match(DEFAULT_CUT_PROMPT, /outro/i)
})

const sampleRow = { url: 'https://youtu.be/abcdefghijk', filename: '', folder: 'D:\\out' }
const sampleAnalysis = {
  name: 'Rescate en el mar',
  segments: [{ start: '1:10', end: '2:40', title: 'Rescate heroico' }],
}

test('review mode does not enqueue a cut job after analyze', () => {
  assert.deepEqual(jobsToEnqueueAfterAnalyze(false, sampleRow, sampleAnalysis), [])
})

test('auto-cut enqueues that row as soon as analyze succeeds', () => {
  assert.deepEqual(jobsToEnqueueAfterAnalyze(true, sampleRow, sampleAnalysis), [{
    url: sampleRow.url,
    filename: 'Rescate en el mar',
    folder: sampleRow.folder,
    segments: sampleAnalysis.segments,
  }])
})

test('auto-cut uses the custom filename when the user typed one', () => {
  const row = { ...sampleRow, filename: 'clip-gia-lai' }
  const [item] = jobsToEnqueueAfterAnalyze(true, row, sampleAnalysis)
  assert.equal(item.filename, 'clip-gia-lai')
})

test('auto-cut skips a row with no valid segments', () => {
  assert.deepEqual(jobsToEnqueueAfterAnalyze(true, sampleRow, { name: 'X', segments: [] }), [])
  assert.deepEqual(jobsToEnqueueAfterAnalyze(true, sampleRow, null), [])
})

test('app AI source shows analyze, hides paste; YouTube source keeps paste as backup', () => {
  const app = cutUiForSource('app')
  assert.equal(app.showAnalyze, true)
  assert.equal(app.showPaste, false)
  assert.equal(app.showCopyPrompt, false)
  assert.equal(app.showAutoCut, true)
  const youtube = cutUiForSource('youtube')
  assert.equal(youtube.showAnalyze, true)
  assert.equal(youtube.showPaste, true)
  assert.equal(youtube.showCopyPrompt, true)
  assert.equal(youtube.showAutoCut, true)
})

test('segmentsToPipeText xuất đúng format team và parser đọc lại được (khứ hồi)', () => {

  const text = segmentsToPipeText('El destino oscuro', [
    { start: '0:33', end: '2:22', title: 'El cazador busca a su hija' },
    { start: 312, end: 448, title: 'Un cementerio maldito' },
  ])
  assert.equal(
    text,
    'Name: El destino oscuro | start_1: 0:33 | end_1: 2:22 | title_bottom_1: El cazador busca a su hija | start_2: 5:12 | end_2: 7:28 | title_bottom_2: Un cementerio maldito'
  )
  const back = parseSegmentsText(text)
  assert.equal(back.name, 'El destino oscuro')
  assert.equal(back.segments.length, 2)
  assert.deepEqual(back.segments[1], { start: '5:12', end: '7:28', title: 'Un cementerio maldito' })
})

test('sửa kết quả sau khi phân tích: text pipe copy ra đổi theo (tên, mốc, tiêu đề, bỏ đoạn)', () => {
  // đúng như trên UI: người dùng sửa tên video / mốc thời gian / tiêu đề rồi bỏ 1 đoạn
  const goc = [
    { start: '0:30', end: '2:32', title: 'La verdad sobre el dragón' },
    { start: '2:32', end: '4:43', title: 'Un sacrificio de amor' },
    { start: '4:43', end: '7:00', title: 'La guerra inminente' },
  ]
  const daSua = goc
    .filter((_, i) => i !== 1) // bấm ✕ bỏ đoạn P2
    .map((s, i) => (i === 0 ? { ...s, start: '0:45', title: 'El secreto del dragón' } : s))
  const text = segmentsToPipeText('Sangre y destino', daSua)
  assert.equal(
    text,
    'Name: Sangre y destino | start_1: 0:45 | end_1: 2:32 | title_bottom_1: El secreto del dragón | start_2: 4:43 | end_2: 7:00 | title_bottom_2: La guerra inminente'
  )
  // và mốc đã sửa phải cắt đúng chỗ mới, không dùng lại mốc cũ
  const items = jobsToEnqueueAfterAnalyze(true, { url: 'https://youtu.be/abc', folder: 'D:/out', filename: '' }, {
    status: 'ready',
    name: 'Sangre y destino',
    segments: daSua,
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].segments.length, 2)
  assert.equal(items[0].segments[0].start, '0:45')
  assert.equal(items[0].segments[0].title, 'El secreto del dragón')
})

test('segmentsToJson xuất đúng định dạng công cụ dựng clip của team', () => {
  const out = segmentsToJson('https://www.youtube.com/watch?v=E0qwJC4TgFc', 'El precio oculto tras la fama', [
    { start: '1:50', end: '3:20', title: '¿Sacrificio extremo por ser modelo?' },
    { start: 818, end: 900, title: 'Colapsó en plena sesión de fotos' },
  ])
  assert.equal(out.url, 'https://www.youtube.com/watch?v=E0qwJC4TgFc')
  assert.equal(out.title_top, 'El precio oculto tras la fama')
  assert.deepEqual([out.font_choice, out.text_color, out.bg_color], ['1', '1', '1'])
  // phút luôn 2 chữ số, kể cả khi mốc gốc là "1:50" hay số giây
  assert.deepEqual(out.cuts[0], { start: '01:50', end: '03:20', title_bottom: 'PARTE 1: ¿Sacrificio extremo por ser modelo?' })
  assert.deepEqual(out.cuts[1], { start: '13:38', end: '15:00', title_bottom: 'PARTE 2: Colapsó en plena sesión de fotos' })
})

test('segmentsToJson không nhân đôi nhãn PARTE khi AI đã tự đánh số', () => {
  const out = segmentsToJson('u', 'n', [{ start: '0:10', end: '1:20', title: 'PARTE 1: Ya tiene etiqueta' }])
  assert.equal(out.cuts[0].title_bottom, 'PARTE 1: Ya tiene etiqueta')
})

test('segmentsToJson xử lý video dài hơn 1 tiếng', () => {
  const out = segmentsToJson('u', 'n', [{ start: 3725, end: 3800, title: 'Sau 1 tiếng' }])
  assert.equal(out.cuts[0].start, '1:02:05')
})

test('segCountBlock: chỉ áp khi 2–20, ngoài khoảng thì rỗng', () => {
  assert.match(segCountBlock(5), /CHÍNH XÁC 5 đoạn/)
  assert.match(segCountBlock(2), /CHÍNH XÁC 2 đoạn/)
  assert.match(segCountBlock(20), /CHÍNH XÁC 20 đoạn/)
  assert.equal(segCountBlock(1), '')
  assert.equal(segCountBlock(21), '')
  assert.equal(segCountBlock(null), '')
  assert.equal(segCountBlock('abc'), '')
})
