/**
 * 真实应用：阻断媒体网络 -> 自动换源耗尽 -> 手动重试，验证不回到 0。
 * 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run dev
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9223'
const OUT = 'e2e/artifacts'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.connectOverCDP(CDP_URL)
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().includes('localhost:1420'))
if (!page) throw new Error('app page not found')
page.setDefaultTimeout(20_000)
const cdp = await page.context().newCDPSession(page)

try {
  for (let round = 0; round < 8; round += 1) {
    await page.keyboard.press('Escape')
    await sleep(300)
    if ((await page.locator('.theater').count()) === 0) break
  }
  if (await page.locator('.theater').count()) {
    await page.locator('.theater-back').click({ force: true }).catch(() => undefined)
    await sleep(800)
  }
  await page.locator('.nav-item', { hasText: /主页|Home/ }).first().click()
  await page.waitForSelector('.poster-card', { timeout: 30_000 })
  await page.locator('.poster-card .card-action').first().click()
  await page.waitForSelector('.theater', { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime > 0.5 && !video.paused
    },
    null,
    { timeout: 180_000 },
  )
  await page.evaluate(() => {
    const video = document.querySelector('.theater-video')
    if (video) video.currentTime = 60
  })
  await sleep(1800)
  const before = await page.evaluate(() => document.querySelector('.theater-video')?.currentTime ?? 0)
  record('seeked to 60s before failure', before >= 55, `currentTime=${before.toFixed(1)}s`)

  await cdp.send('Network.enable')
  await cdp.send('Network.setBlockedURLs', {
    urls: ['*jjstream.localhost*', '*.m3u8*', '*.mp4*', '*.ts*', '*.m4s*'],
  })

  const errorCard = page.locator('.theater-error-card')
  await errorCard.waitFor({ state: 'visible', timeout: 150_000 })
  const errorText = (await errorCard.innerText()).replace(/\s+/g, ' ').slice(0, 120)
  record('media failure reaches error overlay', true, errorText)

  await cdp.send('Network.setBlockedURLs', { urls: [] })
  await sleep(500)
  const retry = page.locator('.theater-error-actions button', { hasText: /重试|Retry/ }).first()
  await retry.click()
  await page.waitForFunction(
    () => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime >= 55 && !video.paused
    },
    null,
    { timeout: 180_000 },
  )
  const after = await page.evaluate(() => document.querySelector('.theater-video')?.currentTime ?? 0)
  record('retry resumes near failure position, not 0', after >= 55, `currentTime=${after.toFixed(1)}s`)

  await page.locator('.theater-back').click()
  await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })
  await sleep(500)
  const saved = await page.evaluate(() => {
    const progress = JSON.parse(localStorage.getItem('jj-progress') ?? '{}')
    return Object.values(progress).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? {}
  })
  record('retry does not overwrite progress with 0', (saved.current ?? 0) >= 55, `saved=${Math.round(saved.current ?? 0)}s`)

  writeFileSync(`${OUT}/retry-resume.json`, JSON.stringify({ results, before, after, saved }, null, 2))
} catch (error) {
  record('retry resume run', false, String(error).slice(0, 400))
} finally {
  await cdp.send('Network.setBlockedURLs', { urls: [] }).catch(() => undefined)
  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}