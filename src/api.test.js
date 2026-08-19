import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiUrl, getApiBase } from './api.js'

test('desktop app uses the port passed in ?api=', () => {
  assert.equal(
    getApiBase({ dev: false, protocol: 'file:', queryApi: 'http://localhost:3007/' }),
    'http://localhost:3007',
  )
})

test('desktop app falls back to the default port without ?api=', () => {
  assert.equal(getApiBase({ dev: false, protocol: 'file:' }), 'http://localhost:3001')
})

test('GitHub Pages build calls the viewer local backend', () => {
  const base = getApiBase({
    dev: false,
    envUrl: '',
    hostname: 'hoangduytn1703.github.io',
    protocol: 'https:',
  })
  assert.equal(base, 'http://localhost:3001')
  assert.equal(
    apiUrl('/api/jobs', { dev: false, hostname: 'hoangduytn1703.github.io', protocol: 'https:' }),
    'http://localhost:3001/api/jobs',
  )
})

test('dev uses the Vite proxy (relative URLs)', () => {
  assert.equal(getApiBase({ dev: true, envUrl: '', hostname: 'localhost' }), '')
  assert.equal(apiUrl('/api/jobs', { dev: true, hostname: 'localhost' }), '/api/jobs')
})

test('VITE_API_URL wins over host defaults', () => {
  assert.equal(
    getApiBase({ dev: false, envUrl: 'https://api.example.com/', hostname: 'hoangduytn1703.github.io' }),
    'https://api.example.com',
  )
})
