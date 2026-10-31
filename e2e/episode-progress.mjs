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

  // 恢复已知状态:关闭遗留的播放器/抽屉。
  await page.mouse.move(640, 80)
  await sleep(300)
  for (let round = 0; round < 4; round += 1) {
    await page.keyboard.press('Escape')
    await sleep(600)
    if ((await page.locator('.theater').count()) === 0) break
  }
  if ((await page.locator('.theater').count()) > 0) {
    await page.locator('.theater-back').click({ force: true })
    await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })
  }

  // 挑一个有历史进度的剧集条目(db- 前缀,恢复位置显著 > 15s,保证断言分辨力):
  // B1 的污染窗口是"切集后 5s 节流覆盖之前",所以新集只播 2.5s 就关闭。
  const pick = await page.evaluate(() => {
    const progress = JSON.parse(localStorage.getItem('jj-progress') ?? '{}')
    const titles = JSON.parse(localStorage.getItem('jj-title-cache') ?? '{}')
    const candidate = Object.entries(progress)
      .filter(([id, value]) => id.startsWith('db-') && (value.current ?? 0) >= 60 && (value.duration ?? 0) > 300)
      .sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0))[0]
    if (!candidate) return null
    const [id, value] = candidate
    const title = titles[id]
    return { id, name: title?.name ?? '', current: Math.round(value.current ?? 0) }
  })
  if (!pick) throw new Error('no db- episode with resume position >= 60s in jj-progress')
  console.log(`[e2e] target: ${pick.id} "${pick.name}" resume≈${pick.current}s`)

  await page.fill('.search-input', '')
  await page.fill('.search-input', pick.name)
  await page.waitForFunction(
    () => document.querySelectorAll('.search-view .poster-card').length > 0,
    null,
    { timeout: 45_000 },
  )
  await sleep(1500)
  await page.locator('.search-view .poster-card .card-action').first().click()
  await page.waitForSelector('.theater', { timeout: 30_000 })
  // 等恢复位置生效(>=30s),必要时从更早位置补播到 30s。
  await page.waitForFunction(() => {
    const video = document.querySelector('.theater-video')
    return video && video.currentTime >= 30 && !video.paused
  }, null, { timeout: 180_000 })
  const before = await page.evaluate(() => {
    const video = document.querySelector('.theater-video')
    return { t: video.currentTime, title: document.querySelector('.theater-id strong')?.textContent ?? '' }
  })
  record('old episode position accrued (>=30s)', before.t >= 30, `t=${before.t.toFixed(1)}s title="${before.title}"`)

  // 切到另一集
  await page.mouse.move(640, 100)
  await sleep(400)
  await page.locator('.theater-tool', { hasText: /剧集|Episodes/ }).first().click({ force: true })
  await page.waitForSelector('.episode-drawer', { timeout: 10_000 })
  const rows = page.locator('.episode-row:not(.is-active):not(.is-disabled)')
  const rowCount = await rows.count()
  if (rowCount === 0) {
    record('switch episode available', false, 'no other playable episode')
    writeFileSync('e2e/artifacts/episode-results.json', JSON.stringify(results, null, 2))
    await browser.close()
    return
  }
  await page.mouse.move(640, 300)
  await sleep(300)
  await rows.nth(0).click({ force: true })
  record('switch episode available', true, `switched among ${rowCount + 1} episodes`)

  // 新集只播 2.5s(<5s 节流窗口),随后立刻关闭 —— 此窗口内旧行为会把旧集位置写到新集。
  await page.waitForFunction(() => {
    const video = document.querySelector('.theater-video')
    return video && video.currentTime > 0.5 && !video.paused
  }, null, { timeout: 120_000 })
  await sleep(2500)
  await page.screenshot({ path: 'e2e/artifacts/06-episode-switched.png' })

  // 循环 Escape:先关剧集抽屉,再关播放器(关闭触发 cleanup 快照 flush)。
  for (let round = 0; round < 3; round += 1) {
    await page.keyboard.press('Escape')
    await sleep(900)
    if ((await page.locator('.theater').count()) === 0) break
  }
  await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })
  await sleep(800)

  const progress = await page.evaluate(() =>
    Object.entries(JSON.parse(localStorage.getItem('jj-progress') ?? '{}')).map(([id, value]) => ({
      id,
      episodeId: value.episodeId,
      current: Math.round(value.current),
      updatedAt: value.updatedAt ?? 0,
    })),
  )
  writeFileSync('e2e/artifacts/episode-progress.json', JSON.stringify(progress, null, 2))

  // B1 硬断言:本次保存的目标条目进度必须仍是"新集的 2.5s"量级(<15s)。
  // 未修复时 cleanup 快照会把旧集位置(>=30s)写进新集记录,断言失败。
  const target = progress.find((entry) => entry.id === pick.id)
  const NEW_EPISODE_UPPER = 15
  const ok = target && target.current >= 1 && target.current <= NEW_EPISODE_UPPER
  record(
    'switched episode progress is fresh (B1)',
    Boolean(ok),
    `saved current=${target?.current}s episodeId=${target?.episodeId ?? 'n/a'} (expect 1~${NEW_EPISODE_UPPER}s; old episode was ${before.t.toFixed(1)}s)`,
  )

  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('[e2e] fatal:', error)
  process.exitCode = 1
})