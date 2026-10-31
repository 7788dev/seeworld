import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9223'
mkdirSync('e2e/artifacts', { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('localhost:1420'))
  if (!page) throw new Error('app page not found')

  // 等首页渲染
  await page.waitForSelector('.poster-card', { timeout: 60_000 })

  // 搜索一部多源剧集
  await page.fill('.search-input', '')
  await page.fill('.search-input', '三体')
  await page.waitForFunction(
    () => document.querySelectorAll('.search-view .poster-card').length > 0,
    null,
    { timeout: 45_000 },
  )
  await sleep(2000)
  await page.locator('.search-view .poster-card .card-action').first().click()
  await page.waitForSelector('.theater', { timeout: 40_000 })
  await page.waitForFunction(() => {
    const video = document.querySelector('.theater-video')
    return video && video.currentTime > 0.5 && !video.paused
  }, null, { timeout: 180_000 })
  record('playing', true)

  // 打开剧集抽屉,等聚合线路就绪(App 后台聚合最多数秒)
  await page.mouse.move(640, 100)
  await sleep(400)
  await page.locator('.theater-tool', { hasText: /剧集|Episodes/ }).first().click({ force: true })
  await page.waitForSelector('.episode-drawer', { timeout: 10_000 })
  await page.waitForFunction(
    () => document.querySelectorAll('.line-tab').length >= 4,
    null,
    { timeout: 60_000 },
  ).catch(() => {})

  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('.line-tab')].map((node) => ({
      label: node.querySelector('span')?.textContent ?? '',
      meta: node.querySelector('em')?.textContent ?? '',
      active: node.classList.contains('is-active'),
      disabled: node.disabled,
    })),
  )
  console.log('[e2e] line tabs:', JSON.stringify(tabs, null, 2))
  writeFileSync('e2e/artifacts/line-tabs.json', JSON.stringify(tabs, null, 2))
  await page.screenshot({ path: 'e2e/artifacts/07-lines-panel.png' })

  // 1) 展示跨源多条线路
  const sources = new Set(tabs.map((tab) => tab.label.split(' · ')[0]).filter(Boolean))
  record('aggregate lines shown (>=2 sources)', sources.size >= 2 && tabs.length >= 4, `${tabs.length} tabs from ${sources.size} sources`)

  // 2) 每条线路带集数标注
  const withEpisodes = tabs.filter((tab) => /\d+\s*集|\d+\s*eps/.test(tab.meta))
  record('each line shows episode count', withEpisodes.length === tabs.length && tabs.length > 0, `${withEpisodes.length}/${tabs.length}`)

  // 3) yun(云播)线路已被 Rust 解析层过滤:不应出现"暂不支持"线路
  const unsupported = tabs.filter((tab) => /暂不支持|unsupported/i.test(tab.meta))
  record('yun/page lines filtered out', unsupported.length === 0, `${unsupported.length} unsupported`)

  // 4) 当前播放线路显示"播放中"而非"探测失败"
  const activeTab = tabs.find((tab) => tab.active)
  record(
    'active line shows playing state (probe bug fixed)',
    Boolean(activeTab) && /播放中|Playing/.test(activeTab.meta) && !/探测失败|probe failed/i.test(activeTab.meta),
    activeTab?.meta ?? 'no active tab',
  )

  // 5) 跨源切换:点击另一条可播线路,等待新源起播
  const target = tabs.find((tab) => !tab.active && !tab.disabled)
  if (target) {
    const label = target.label
    await page.locator('.line-tab', { hasText: label.split(' · ')[0] }).last().click({ force: true })
    await page.waitForFunction(() => {
      const video = document.querySelector('.theater-video')
      return video && video.currentTime > 0.5 && !video.paused
    }, null, { timeout: 180_000 })
    await sleep(4000)
    const tabsAfter = await page.evaluate(() =>
      [...document.querySelectorAll('.line-tab')].map((node) => ({
        label: node.querySelector('span')?.textContent ?? '',
        active: node.classList.contains('is-active'),
      })),
    )
    const nowActive = tabsAfter.find((tab) => tab.active)
    record(
      'cross-source line switch works',
      nowActive?.label === label || nowActive?.label.includes(label.split(' · ')[0]),
      `switched to "${label}" -> active "${nowActive?.label ?? ''}"`,
    )
  } else {
    record('cross-source line switch works', false, 'no alternate playable line')
  }

  await page.screenshot({ path: 'e2e/artifacts/08-after-switch.png' })
  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('[e2e] fatal:', error)
  process.exitCode = 1
})