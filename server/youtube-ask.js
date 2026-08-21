import os from 'os'
import path from 'path'
import { parseSegmentsText, buildPrompt } from '../src/parse.js'
import { normalizeSegments } from './gemini.js'

const ASK_BTN = /Đặt câu hỏi|Hỏi về video này|Ask about this video|^Ask$/i
const ASK_BOX = /Đặt câu hỏi|Ask a question|Ask about this video/i
const MARKER = 'CUT_RESULT:'
export const NO_ASK_MESSAGE = 'Video không có nút Đặt câu hỏi dưới player (Ask Gemini trên thanh Chrome không tính). Cần đăng nhập Google trong đúng cửa sổ Chrome app vừa mở.'
export const CHROME_LOCK_MESSAGE = 'Chrome đang mở nên không lấy được profile đã login. Tắt hẳn Chrome (cả icon khay hệ thống) rồi bấm Phân tích lại — app sẽ mở Chrome của bạn, có sẵn Đặt câu hỏi.'

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--profile-directory=Default']

let ctxPromise = null
let queue = Promise.resolve()

export function isClosedBrowserError(msg) {
  return /has been closed|Target closed|browser has been closed/i.test(String(msg || ''))
}

export function isProfileLockError(msg) {
  return /ProcessSingleton|already in use|user data directory|profile is already/i.test(String(msg || ''))
}

function enqueue(fn) {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

function forgetContext() {
  ctxPromise = null
}

function watchContext(ctx) {
  ctx.on('close', forgetContext)
  return ctx
}

async function hideAutomation(ctx) {
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
}

export function chromeUserDataDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  return path.join(os.homedir(), '.config', 'google-chrome')
}

async function launchUserChrome(chromium) {
  const ctx = await chromium.launchPersistentContext(chromeUserDataDir(), {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1400, height: 900 },
    locale: 'vi-VN',
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
    args: STEALTH_ARGS,
  })
  await hideAutomation(ctx)
  return watchContext(ctx)
}

async function getContext(chromium) {
  if (ctxPromise) {
    try {
      const ctx = await ctxPromise
      if (ctx.browser()?.isConnected()) return ctx
    } catch {}
    forgetContext()
  }
  ctxPromise = launchUserChrome(chromium).catch(err => {
    forgetContext()
    if (isProfileLockError(err?.message)) throw new Error(CHROME_LOCK_MESSAGE)
    throw new Error('Không mở được Chrome của bạn: ' + (err?.message || err))
  })
  return ctxPromise
}

async function getWorkingPage(chromium) {
  const ctx = await getContext(chromium)
  try {
    const yt = ctx.pages().find(p => /youtube\.com\/watch/i.test(p.url() || ''))
    const page = yt || await ctx.newPage()
    return { ctx, page }
  } catch (err) {
    if (!isClosedBrowserError(err?.message)) throw err
    forgetContext()
    const fresh = await getContext(chromium)
    return { ctx: fresh, page: await fresh.newPage() }
  }
}

function parseAskText(text) {
  const cut = String(text || '')
  const marked = cut.includes(MARKER) ? cut.slice(cut.lastIndexOf(MARKER) + MARKER.length) : cut
  const parsed = parseSegmentsText(marked)
  const segments = normalizeSegments(parsed.segments)
  return { name: parsed.name, segments }
}

export async function analyzeViaYoutubeAsk(url, { prompt } = {}) {
  let chromium
  try {
    ;({ chromium } = await import('playwright-core'))
  } catch {
    throw new Error('Chưa cài playwright-core — chạy npm install playwright-core rồi thử lại')
  }
  const fullPrompt = `${buildPrompt(prompt)}\n\nBắt đầu câu trả lời bằng ${MARKER}`
  return enqueue(async () => {
    const { page } = await getWorkingPage(chromium)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.getByRole('button', { name: /Accept all|Chấp nhận tất cả|I agree/i }).click({ timeout: 2500 }).catch(() => {})
      await page.getByRole('button', { name: ASK_BTN }).first().click({ timeout: 20000 })
      const box = page.getByPlaceholder(ASK_BOX).last()
      await box.waitFor({ timeout: 15000 })
      await box.fill(fullPrompt)
      await box.press('Enter')
      await page.waitForFunction(marker => {
        const nodes = document.querySelectorAll('p, span, yt-formatted-string, div')
        for (const n of nodes) {
          if (n.childElementCount > 2) continue
          const t = n.textContent || ''
          if (t.includes(marker) && (t.includes('start_1') || t.includes('start_ 1'))) return true
        }
        return false
      }, MARKER, { timeout: 90000 })
      const body = await page.innerText('body')
      const result = parseAskText(body)
      if (!result.segments.length) throw new Error('YouTube AI không trả mốc cắt đọc được — thử lại hoặc dùng AI trong app')
      return result
    } catch (err) {
      const msg = err?.message || String(err)
      if (isClosedBrowserError(msg)) forgetContext()
      if (/Timeout/i.test(msg)) throw new Error(NO_ASK_MESSAGE)
      throw err
    }
    // Keep the YouTube tab open so the next link reuses it — do not leave about:blank.
  })
}

export { parseAskText }
