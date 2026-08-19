import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import express from 'express'
import { collectSpawnOutput, sendJsonOnce } from './http-utils.js'

function mockRes() {
  return {
    headersSent: false,
    body: undefined,
    json(payload) {
      if (this.headersSent) {
        throw new Error('Cannot set headers after they are sent to the client')
      }
      this.headersSent = true
      this.body = payload
    },
  }
}

test('sendJsonOnce ignores a second call instead of crashing', () => {
  const res = mockRes()
  sendJsonOnce(res, { folder: null })
  sendJsonOnce(res, { folder: '/tmp' })
  assert.deepEqual(res.body, { folder: null })
})

test('collectSpawnOutput resolves once when spawn emits error then close', async () => {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  const result = collectSpawnOutput(proc)
  proc.emit('error', Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }))
  proc.emit('close', 1)
  assert.equal(await result, null)
})

test('collectSpawnOutput returns trimmed stdout on close', async () => {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  const result = collectSpawnOutput(proc)
  proc.stdout.emit('data', Buffer.from('/home/duynh/Downloads\n'))
  proc.emit('close', 0)
  assert.equal(await result, '/home/duynh/Downloads')
})

test('GET /api/pick-folder stays alive when the picker binary is missing', async () => {
  const app = express()
  app.get('/api/pick-folder', async (req, res) => {
    const proc = spawn('powershell-does-not-exist-on-linux', [])
    sendJsonOnce(res, { folder: await collectSpawnOutput(proc) })
  })
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}/api/pick-folder`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.folder, null)
  await new Promise(resolve => server.close(resolve))
})
