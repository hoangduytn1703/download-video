import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiUrl, getApiBase } from './api.js'

test('GitHub Pages build calls the viewer local backend', () => {
  const base = getApiBase({
    dev: false,
    envUrl: '',
    hostname: 'hoangduytn1703.github.io',
  })
  assert.equal(base, 'http://localhost:3001')
  assert.equal(
    apiUrl('/api/jobs', { dev: false, hostname: 'hoangduytn1703.github.io' }),
    'http://localhost:3001/api/jobs',
  )
})

test('dev uses the Vite proxy (relative URLs)', () => {
  assert.equal(getApiBase({ dev: true, envUrl: '', hostname: 'localhost' }), '')
  assert.equal(apiUrl('/api/jobs', { dev: true, hostname: 'localhost' }), '/api/jobs')
})

test('VITE_API_URL wins when set', () => {
  assert.equal(
    getApiBase({ dev: false, envUrl: 'https://api.example.com/', hostname: 'hoangduytn1703.github.io' }),
    'https://api.example.com',
  )
})
