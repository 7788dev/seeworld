import { mkdirSync } from 'node:fs'
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

  // 若播放器未打开,先播放当前搜索结果第一项
  if ((await page.locator('.theater').count()) === 0) {
    await page.fill('.search-input', '')
    await page.fill('.search-input', '三体')
    await page.waitForFunction(
      () => document.querySelectorAll('.search-view .poster-card').length > 0,
      null,
      { timeout: 45_000 },
    )
    await sleep(1500)
    await page.locator('.search-view .poster-card .card-action').first().click()
  }
  await page.waitForSelector('.theater', { timeout: 60_000 })

  // 打开剧集抽屉并等聚合线路；若抽屉已打开则不要重复点击（点击会关闭）
  if ((await page.locator('.episode-drawer').count()) === 0) {
    await page.mouse.move(640, 100)
    await sleep(400)
    await page.locator('.theater-tool', { hasText: /剧集|Episodes/ }).first().click({ force: true })
  }
  await page.waitForSelector('.episode-drawer', { timeout: 10_000 })
  await page.waitForFunction(
    () => document.querySelectorAll('.line-tab').length >= 3,
    null,
    { timeout: 60_000 },
  )

  const scrollState = () =>
    page.evaluate(() => {
      const node = document.querySelector('.line-tabs')
      return { scrollLeft: node.scrollLeft, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }
    })

  const box = await page.locator('.line-tabs').boundingBox()
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  // 1) 滚轮横滚:鼠标悬停在线路条上,垂直滚轮应转为横向滚动
  await page.mouse.move(center.x, center.y)
  await sleep(200)
  const beforeWheel = await scrollState()
  await page.mouse.wheel(0, 160)
  await sleep(400)
  const afterWheel = await scrollState()
  record(
    'wheel scrolls line tabs horizontally',
    afterWheel.scrollWidth > afterWheel.clientWidth && afterWheel.scrollLeft > beforeWheel.scrollLeft,
    `scrollLeft ${beforeWheel.scrollLeft} -> ${afterWheel.scrollLeft} (scrollWidth ${afterWheel.scrollWidth}, viewport ${afterWheel.clientWidth})`,
  )

  // 2) 按住拖拽:向右拖动应回滚 scrollLeft
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(center.x + step * 25, center.y, { steps: 1 })
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(300)
  const afterDrag = await scrollState()
  record(
    'drag scrolls line tabs',
    afterDrag.scrollLeft !== afterWheel.scrollLeft,
    `scrollLeft ${afterWheel.scrollLeft} -> ${afterDrag.scrollLeft}`,
  )

  // 3) 拖拽不误触线路切换:拖拽结束后的 active 线路不变
  const activeBefore = await page.evaluate(
    () => document.querySelector('.line-tab.is-active span')?.textContent ?? '',
  )
  const activeAfter = await page.evaluate(
    () => document.querySelector('.line-tab.is-active span')?.textContent ?? '',
  )
  record('drag does not trigger line switch', activeBefore === activeAfter, `"${activeBefore}" stays active`)

  await page.screenshot({ path: 'e2e/artifacts/09-lines-scroll.png' })
  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('[e2e] fatal:', error)
  process.exitCode = 1
})