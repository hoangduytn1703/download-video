export function sendJsonOnce(res, body) {
  if (res.headersSent || res.writableEnded) return
  res.json(body)
}

export function collectSpawnOutput(proc) {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    proc.stdout?.on('data', chunk => {
      out += chunk.toString()
    })
    proc.on('close', () => done(out.trim() || null))
    proc.on('error', () => done(null))
  })
}
