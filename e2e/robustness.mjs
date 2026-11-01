/**
 * 健壮性与可达性 E2E（补齐 smoke.mjs 的空白区）。
 *
 * 覆盖：
 *  - 设置页：三个破坏性操作存在且必须二次确认（第一次点击不清数据），4s 后自动撤销
 *  - 空结果：搜索一个不存在的片名，显示空态而不是白屏/崩溃
 *  - 键盘：Tab 焦点困在弹层内，Escape 关闭详情
 *  - 播放器：倍速按钮存在并能改到 video.playbackRate
 *
 * 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run dev
 * 注：不做真断网（CDP setOffline 对 WebView2 不可靠，会挂死后续步骤），
 *     断网路径以「无结果 + 无异常」近似覆盖，真断网需手动验证。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9223'
const ART_DIR = 'e2e/artifacts'
mkdirSync(ART_DIR, { recursive: true })

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForCdp(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CDP_URL}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // not ready yet
    }
    await sleep(1500)
  }
  throw new Error(`CDP endpoint not reachable at ${CDP_URL}`)
}

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
    page = await contexts[0].newPage()
    await page.goto('http://localhost:1420', { waitUntil: 'domcontentloaded' })
  }
  page.setDefaultTimeout(20_000)

  const jsExceptions = []
  page.on('pageerror', (error) => jsExceptions.push(String(error).slice(0, 300)))

  const goHome = async () => {
    await page.locator('.nav-item', { hasText: /主页|Home/ }).first().click()
    await page.waitForSelector('.poster-card', { timeout: 30_000 })
  }

  await goHome()

  // ---- 1. 设置页：破坏性操作必须二次确认 ----
  try {
    await page.locator('.nav-item', { hasText: /设置|Settings/ }).first().click()
    await page.waitForSelector('.account-data', { timeout: 10_000 })
    const buttons = page.locator('.settings-toggle--danger')
    const count = await buttons.count()
    const progressBefore = await page.evaluate(() => localStorage.getItem('jj-progress'))
    await buttons.first().click()
    await sleep(300)
    const progressAfterFirstClick = await page.evaluate(() => localStorage.getItem('jj-progress'))
    const armed = await buttons.first().evaluate((node) => node.classList.contains('is-armed'))
    record(
      'destructive action needs confirmation',
      count >= 3 && armed && progressAfterFirstClick === progressBefore,
      `${count} actions, armed=${armed}, data untouched=${progressAfterFirstClick === progressBefore}`,
    )
    await sleep(4200)
    const stillArmed = await buttons.first().evaluate((node) => node.classList.contains('is-armed'))
    record('armed state auto-revokes', !stillArmed, `armed=${stillArmed}`)
  } catch (error) {
    record('destructive action needs confirmation', false, String(error).slice(0, 200))
  }

  // ---- 2. 空结果：不白屏、不崩溃 ----
  try {
    await goHome()
    await page.fill('.search-input', 'zzz不存在的片名qqq')
    await sleep(5000)
    const state = await page.evaluate(() => ({
      searchView: Boolean(document.querySelector('.search-view')),
      emptyState: Boolean(document.querySelector('.search-view .empty-state')),
      // 搜索错误态也使用 role=alert，不能把它当成 ErrorBoundary 崩溃。
      crashed: Boolean(document.querySelector('[role="alert"]')) &&
        document.body.innerText.includes('页面遇到了一点问题'),
    }))
    record(
      'empty search shows empty state, not a blank screen',
      state.searchView && state.emptyState && !state.crashed,
      JSON.stringify(state),
    )
    await page.fill('.search-input', '')
    await sleep(600)
  } catch (error) {
    record('empty search shows empty state, not a blank screen', false, String(error).slice(0, 200))
  }

  // ---- 3. 键盘：Escape 关详情 + Tab 困在弹层 ----
  try {
    await goHome()
    await page.locator('.poster-card .card-hit').first().click()
    await page.waitForSelector('.detail-modal', { timeout: 15_000 })

    let escaped = false
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(() => {
        const modal = document.querySelector('.detail-modal')
        return Boolean(modal && modal.contains(document.activeElement))
      })
      if (!inside) {
        escaped = true
        break
      }
    }
    record('focus stays inside detail modal', !escaped, escaped ? 'focus escaped after Tab' : '24 tabs stayed inside')

    await page.keyboard.press('Escape')
    await page.waitForSelector('.detail-modal', { state: 'detached', timeout: 8_000 })
    record('escape closes detail modal', true)
  } catch (error) {
    record('focus stays inside detail modal', false, String(error).slice(0, 200))
  }

  // ---- 4. 播放器倍速 ----
  try {
    await page.locator('.poster-card .card-action').first().click()
    await page.waitForSelector('.theater', { timeout: 30_000 })
    await page.waitForSelector('.rate-btn', { timeout: 15_000 })
    // 视频 metadata 就绪后再测倍速；加载中点击会先被下一次 load 重置，属于测试竞态。
    await page.waitForFunction(
      () => {
        const video = document.querySelector('.theater-video')
        return video && video.readyState >= 2
      },
      null,
      { timeout: 150_000 },
    )
    const before = await page.evaluate(() => document.querySelector('.theater-video')?.playbackRate ?? 0)
    await page.locator('.rate-btn').click()
    await page.waitForFunction(
      (previous) => document.querySelector('.theater-video')?.playbackRate !== previous,
      before,
      { timeout: 15_000 },
    ).catch(() => undefined)
    await sleep(300)
    const after = await page.evaluate(() => ({
      rate: document.querySelector('.theater-video')?.playbackRate ?? 0,
      label: document.querySelector('.rate-btn')?.textContent ?? '',
    }))
    record(
      'playback rate button changes video rate',
      after.rate !== before && after.label.includes('×'),
      `${before} -> ${after.rate} (${after.label})`,
    )
    // 复原 1×，避免影响后续手动测试
    await page.locator('.rate-btn').click()
    await page.locator('.theater-back').click()
    await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })
  } catch (error) {
    record('playback rate button changes video rate', false, String(error).slice(0, 200))
  }

  record('no JS exceptions during robustness run', jsExceptions.length === 0, jsExceptions.slice(0, 2).join(' | '))

  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  writeFileSync(`${ART_DIR}/robustness.json`, JSON.stringify({ results }, null, 2))
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
