/**
 * 真实应用：每集独立续播 + 继续观看货架。
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
page.setDefaultTimeout(15_000)

try {
  // 清理遗留弹层
  for (let round = 0; round < 6; round += 1) {
    await page.keyboard.press('Escape')
    await sleep(300)
    if ((await page.locator('.theater').count()) === 0) break
  }
  if (await page.locator('.theater').count()) {
    await page.locator('.theater-back').click({ force: true }).catch(() => undefined)
    await sleep(800)
  }

  await page.fill('.search-input', '')
  await page.fill('.search-input', '三体')
  await page.waitForFunction(
    () => document.querySelectorAll('.search-view .poster-card').length > 0,
    null,
    { timeout: 45_000 },
  )
  await sleep(1500)
  await page.locator('.search-view .poster-card .card-action').first().click()
  await page.waitForSelector('.theater', { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime > 0.5 && !video.paused
    },
    null,
    { timeout: 180_000 },
  )
  record('series first frame', true)

  // 播到 60s 后关闭，触发 closePlayback 强制 flush
  await page.evaluate(() => {
    const video = document.querySelector('.theater-video')
    if (video) video.currentTime = 60
  })
  await sleep(1800)
  await page.locator('.theater-back').click()
  await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })
  await sleep(500)

  const afterFirst = await page.evaluate(() => {
    const progress = JSON.parse(localStorage.getItem('jj-progress') ?? '{}')
    const episodes = JSON.parse(localStorage.getItem('jj-episode-progress') ?? '{}')
    const newest = Object.entries(progress)
      .sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0))[0]
    const titleId = newest?.[0] ?? ''
    const value = newest?.[1] ?? {}
    return {
      titleId,
      current: value.current ?? 0,
      episodeId: value.episodeId ?? '',
      episodeEntries: titleId ? Object.keys(episodes[titleId] ?? {}).length : 0,
    }
  })
  record(
    'title and episode progress persisted after close',
    afterFirst.current >= 55 && afterFirst.episodeEntries >= 1,
    JSON.stringify(afterFirst),
  )

  // 重开同一标题，进入下一集，再回到上一集
  await page.fill('.search-input', '')
  await page.fill('.search-input', '三体')
  await page.waitForFunction(
    () => document.querySelectorAll('.search-view .poster-card').length > 0,
    null,
    { timeout: 45_000 },
  )
  await sleep(1500)
  await page.locator('.search-view .poster-card .card-action').first().click()
  await page.waitForSelector('.theater', { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime > 0.5 && !video.paused
    },
    null,
    { timeout: 180_000 },
  )
  const resumed = await page.evaluate(() => document.querySelector('.theater-video')?.currentTime ?? 0)
  record('reopen resumes same episode', resumed >= 55, `currentTime=${resumed.toFixed(1)}s`)

  await page.mouse.move(640, 100)
  await sleep(400)
  await page.locator('.theater-tool', { hasText: /剧集|Episodes/ }).first().click({ force: true })
  await page.waitForSelector('.episode-drawer', { timeout: 10_000 })
  const rows = page.locator('.episode-row:not(.is-active):not(.is-disabled)')
  if ((await rows.count()) === 0) throw new Error('no other playable episode')
  await rows.first().click({ force: true })
  await page.waitForFunction(
    () => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime > 0.5 && !video.paused
    },
    null,
    { timeout: 180_000 },
  )
  record('switch to next episode', true)

  await page.mouse.move(640, 100)
  await sleep(300)
  await page.locator('.episode-row').first().click({ force: true })
  await page.waitForFunction(
    () => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime >= 55 && !video.paused
    },
    null,
    { timeout: 180_000 },
  )
  const back = await page.evaluate(() => document.querySelector('.theater-video')?.currentTime ?? 0)
  record('switch back resumes per-episode progress', back >= 55, `currentTime=${back.toFixed(1)}s`)

  await page.locator('.theater-back').click()
  await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })
  await page.locator('.nav-item', { hasText: /主页|Home/ }).first().click()
  await page.waitForSelector('.poster-card', { timeout: 30_000 })
  await page.waitForFunction(
    () => [...document.querySelectorAll('.shelf h2')].some((node) => /继续观看|Continue Watching/.test(node.textContent ?? '')),
    null,
    { timeout: 20_000 },
  )
  const shelf = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('.shelf h2')].find((node) =>
      /继续观看|Continue Watching/.test(node.textContent ?? ''),
    )
    return Boolean(heading)
  })
  record('home shows continue watching shelf', shelf)

  writeFileSync(`${OUT}/episode-resume.json`, JSON.stringify({ results, afterFirst, resumed, back }, null, 2))
} catch (error) {
  record('episode resume run', false, String(error).slice(0, 300))
} finally {
  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}