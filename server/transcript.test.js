import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickCaptionTrack, parseJson3, parseVtt, formatTranscript, extractCaptionTracks } from './transcript.js'

const tracks = [
  { languageCode: 'en', kind: 'asr', baseUrl: 'http://en' },
  { languageCode: 'vi', kind: 'asr', baseUrl: 'http://vi' },
  { languageCode: 'es', baseUrl: 'http://es' },
]

test('pickCaptionTrack prefers Vietnamese then Spanish then English', () => {
  assert.equal(pickCaptionTrack(tracks).baseUrl, 'http://vi')
  assert.equal(pickCaptionTrack(tracks.filter(t => t.languageCode !== 'vi')).baseUrl, 'http://es')
  assert.equal(pickCaptionTrack([{ languageCode: 'fr', baseUrl: 'http://fr' }]).baseUrl, 'http://fr')
  assert.equal(pickCaptionTrack([]), null)
})

test('parseJson3 reads timed cues and skips blank events', () => {
  const cues = parseJson3({
    events: [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Xin ' }, { utf8: 'chao' }] },
      { tStartMs: 3000, segs: [{ utf8: '\n' }] },
      { tStartMs: 461000, segs: [{ utf8: 'Cuoi video' }] },
    ],
  })
  assert.deepEqual(cues, [
    { start: 1, text: 'Xin chao' },
    { start: 461, text: 'Cuoi video' },
  ])
})

test('formatTranscript writes mm:ss lines for Gemini', () => {
  const text = formatTranscript([
    { start: 1, text: 'Xin chao' },
    { start: 70, text: 'Hook manh' },
  ])
  assert.match(text, /\[0:01\] Xin chao/)
  assert.match(text, /\[1:10\] Hook manh/)
})

test('extractCaptionTracks reads tracks and ignores braces inside strings', () => {
  const html = `ytInitialPlayerResponse = {"foo":"not } a brace","captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"languageCode":"vi","baseUrl":"http://vi-cap","kind":"asr"}]}}};`
  const tracks = extractCaptionTracks(html)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].baseUrl, 'http://vi-cap')
})

test('parseVtt reads cue times and strips tags', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c>Xin</c> chao

00:01:10.500 --> 00:01:12.000
Hook manh
`
  const cues = parseVtt(vtt)
  assert.equal(cues.length, 2)
  assert.equal(cues[0].start, 1)
  assert.equal(cues[0].text, 'Xin chao')
  assert.equal(cues[1].start, 70.5)
})
