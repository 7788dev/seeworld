import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9223'
const ART_DIR = 'e2e/artifacts'
mkdirSync(ART_DIR, { recursive: true })

const results = []
const consoleIssues = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitForCdp(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CDP_URL}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error(`CDP endpoint not reachable at ${CDP_URL}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const version = await waitForCdp()
  console.log(`[e2e] CDP connected: ${version.Browser}`)
  const browser = await chromium.connectOverCDP(CDP_URL)
  const contexts = browser.contexts()
  let page = null
  for (const context of contexts) {
    for (const candidate of context.pages()) {
      if (candidate.url().includes('localhost:1420')) {
        page = candidate
        break
      }
    }
    if (page) break
  }
  if (!page) {
    const context = contexts[0]
    page = await context.newPage()
    await page.goto('http://localhost:1420', { waitUntil: 'domcontentloaded' })
  }
  page.on('console', (message) => {
    const text = message.text()
    if (
      message.type() === 'error' ||
      /refused|violat|Content Security Policy/i.test(text)
    ) {
      consoleIssues.push(text.slice(0, 400))
    }
  })
  const jsExceptions = []
  page.on('pageerror', (error) => {
    jsExceptions.push(String(error).slice(0, 300))
  })

  const shot = async (name) => {
    try {
      await page.screenshot({ path: `${ART_DIR}/${name}.png` })
    } catch {
      // screenshots are best-effort
    }
  }

  // 1. 首页渲染(豆瓣 feed)
  try {
    await page.waitForSelector('.poster-card', { timeout: 60_000 })
    const count = await page.locator('.poster-card').count()
    record('home feed renders cards', count >= 6, `${count} cards`)
  } catch (error) {
    record('home feed renders cards', false, String(error).slice(0, 200))
  }
  await shot('01-home')

  // 2. CSP:页面加载后不应有 CSP 拦截错误
  const cspIssues = consoleIssues.filter((text) => /Content Security Policy/i.test(text))
  record('no CSP violations', cspIssues.length === 0, cspIssues.slice(0, 2).join(' | '))

  // 3. 分类页 + 无限瀑布流
  try {
    await page.locator('.nav-item', { hasText: /电影|Movies/ }).first().click()
    await page.waitForSelector('.page-view', { timeout: 15_000 })
    await sleep(4000)
    const before = await page.locator('.poster-card').count()
    await page.locator('.main-scroll').evaluate((node) => node.scrollTo({ top: node.scrollHeight }))
    await page.waitForFunction(
      (previous) => document.querySelectorAll('.poster-card').length > previous,
      before,
      { timeout: 45_000 },
    )
    const after = await page.locator('.poster-card').count()
    record('browse view + infinite scroll appends', after > before, `${before} -> ${after}`)
  } catch (error) {
    record('browse view + infinite scroll appends', false, String(error).slice(0, 200))
  }
  await shot('02-browse')

  // 4. 搜索(豆瓣联想 + 播放源聚合)
  try {
    await page.fill('.search-input', '流浪地球')
    await page.waitForFunction(
      () => document.querySelectorAll('.search-view .poster-card').length > 0,
      null,
      { timeout: 45_000 },
    )
    await page.waitForFunction(
      () => {
        const view = document.querySelector('.search-view')
        return Boolean(view) && view.getAttribute('aria-busy') === 'false'
      },
      null,
      { timeout: 45_000 },
    )
    const count = await page.locator('.search-view .poster-card').count()
    record('search returns results', count > 0, `${count} results`)
    const psIds = await page.evaluate(() =>
      [...document.querySelectorAll('.search-view .poster-card')]
        .map((node) => node.querySelector('.card-hit')?.getAttribute('aria-label') ?? ''),
    )
    writeFileSync(`${ART_DIR}/search-results.json`, JSON.stringify(psIds, null, 2))
  } catch (error) {
    record('search returns results', false, String(error).slice(0, 200))
  }
  await shot('03-search')

  // 5. 详情弹层(ps- 条目解析 + 源站剧集增强)
  try {
    const sourceCards = page
      .locator('.search-view .poster-card')
      .filter({ has: page.locator('.card-source') })
    const sourceSeries = sourceCards.filter({ hasText: '剧集' })
    const targetCard =
      (await sourceSeries.count()) > 0
        ? sourceSeries.first()
        : (await sourceCards.count()) > 0
          ? sourceCards.first()
          : page.locator('.search-view .poster-card').first()
    await targetCard.locator('.card-hit').click()
    await page.waitForSelector('.detail-modal', { timeout: 20_000 })
    await page
      .waitForSelector('.detail-episode', { timeout: 20_000 })
      .catch(() => undefined)
    const episodeRows = await page.locator('.detail-episode').count()
    record('detail modal opens', true, `${episodeRows} episode rows`)
    await page.locator('.modal-close').click()
    await page.waitForSelector('.detail-modal', { state: 'detached', timeout: 10_000 })
  } catch (error) {
    record('detail modal opens', false, String(error).slice(0, 200))
  }
  await shot('04-detail')

  // 6. 播放:从详情/卡片直接播放,等待真实首帧
  try {
    await page.locator('.search-view .poster-card .card-action').first().click()
    await page.waitForSelector('.theater', { timeout: 30_000 })
    record('theater opens', true)
    // 等待视频首帧(video.currentTime > 0.5s),自动换源窗口很长,上限 150s
    await page.waitForFunction(() => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime > 0.5 && !video.paused
    }, null, { timeout: 150_000 })
    const state = await page.evaluate(() => {
      const video = document.querySelector('.theater-video')
      const proxyChip = document.querySelector('.quality-chip--proxy')?.textContent ?? ''
      return {
        currentTime: video.currentTime,
        duration: video.duration,
        videoWidth: video.videoWidth,
        src: (video.currentSrc || video.src || '').slice(0, 120),
        proxyChip,
      }
    })
    record(
      'video reaches first frame',
      state.currentTime > 0.5 && state.videoWidth > 0,
      JSON.stringify(state),
    )
    // HLS 经 MSE 后 currentSrc 是 blob:,真实流 URL 从 performance 资源里找。
    const streams = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('jjstream.localhost')),
    )
    const tokened = streams.filter((name) => /k=[0-9a-f]{16}/.test(name))
    record(
      'jjstream requests carry startup token',
      streams.length > 0 && tokened.length === streams.length,
      `${tokened.length}/${streams.length} tokened`,
    )
    writeFileSync(`${ART_DIR}/stream-urls.json`, JSON.stringify(streams.slice(0, 5), null, 2))
  } catch (error) {
    record('video reaches first frame', false, String(error).slice(0, 300))
  }
  await shot('05-playing')

  // 7. 播放器键盘控制:空格暂停
  try {
    await page.keyboard.press('Space')
    await sleep(1200)
    const paused = await page.evaluate(
      () => document.querySelector('.theater-video')?.paused ?? false,
    )
    await page.keyboard.press('Space')
    record('space toggles pause', paused, `paused=${paused}`)
  } catch (error) {
    record('space toggles pause', false, String(error).slice(0, 200))
  }

  // 8. 进度持久化:关闭播放器后 jj-progress 应有记录
  try {
    await page.locator('.theater-back').click()
    await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })
    const progress = await page.evaluate(() => {
      const raw = localStorage.getItem('jj-progress')
      const map = raw ? JSON.parse(raw) : {}
      const entries = Object.entries(map)
      return { keys: entries.length, sample: entries[0]?.[0] ?? '' }
    })
    record('progress persisted on close', progress.keys > 0, JSON.stringify(progress))
  } catch (error) {
    record('progress persisted on close', false, String(error).slice(0, 200))
  }

  // 9. console 健康度:JS 异常与 CSP 拦截才算失败;
  // 资源 4xx/5xx(豆瓣图源/播放源分片偶发 502)只记录,不影响功能判定。
  const blockingIssues = consoleIssues.filter(
    (text) => /Content Security Policy|Uncaught|is not defined|cannot read/i.test(text),
  )
  record(
    'no JS exceptions or CSP violations',
    blockingIssues.length === 0 && jsExceptions.length === 0,
    [...blockingIssues, ...jsExceptions].slice(0, 3).join(' | '),
  )
  record(
    'no unexpected console errors',
    consoleIssues.length === 0,
    `${consoleIssues.length} issues (network noise tolerated): ${consoleIssues.slice(0, 2).join(' | ')}`,
  )

  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  writeFileSync(`${ART_DIR}/results.json`, JSON.stringify({ results, consoleIssues }, null, 2))
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    console.log(`[e2e] failed: ${failed.map((entry) => entry.name).join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('[e2e] fatal:', error)
  process.exitCode = 1
})