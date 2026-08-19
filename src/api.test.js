import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiUrl, getApiBase } from './api.js'

test('GitHub Pages production does not call localhost', () => {
  const base = getApiBase({
    dev: false,
    envUrl: '',
    hostname: 'hoangduytn1703.github.io',
  })
  assert.equal(base, '')
  assert.equal(apiUrl('/api/jobs', { dev: false, hostname: 'hoangduytn1703.github.io' }), '/api/jobs')
  assert.ok(!base.includes('localhost'))
})

test('VITE_API_URL wins when set', () => {
  assert.equal(
    getApiBase({ dev: false, envUrl: 'https://api.example.com/', hostname: 'hoangduytn1703.github.io' }),
    'https://api.example.com',
  )
})
