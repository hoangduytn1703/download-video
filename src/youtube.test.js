import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVideoId, sanitizeFilename, suggestedFilename, isYouTubeUrl } from './youtube.js'

test('parseVideoId reads watch, shorts, and youtu.be links', () => {
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=LImkl5UvJCY&list=abc'), 'LImkl5UvJCY')
  assert.equal(parseVideoId('https://youtu.be/LImkl5UvJCY'), 'LImkl5UvJCY')
  assert.equal(parseVideoId('https://www.youtube.com/shorts/LImkl5UvJCY'), 'LImkl5UvJCY')
})

test('parseVideoId rejects non-YouTube urls', () => {
  assert.equal(parseVideoId('https://vimeo.com/123'), null)
  assert.equal(parseVideoId('not a url'), null)
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=LImkl5UvJCY'), true)
  assert.equal(isYouTubeUrl('https://vimeo.com/123'), false)
})

test('suggestedFilename prefers custom name and strips illegal characters', () => {
  assert.equal(suggestedFilename('sdsa', 'Some Title'), 'sdsa.mp4')
  assert.equal(suggestedFilename('a/b:c', 'Title'), 'abc.mp4')
  assert.equal(suggestedFilename('', 'My Video'), 'My Video.mp4')
})
