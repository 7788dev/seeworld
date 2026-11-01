/**
 * 真实应用：本轮新增/变更功能的 E2E。
 * 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run dev
 *
 * 会修改 localStorage 与用户播放源配置；脚本在 finally 中恢复 localStorage。
 * 播放源配置/应用数据由外层备份恢复。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

const snapshot = await page.evaluate(() => {
  const data = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith('jj-')) data[key] = localStorage.getItem(key)
  }
  return data
})

const resetOverlays = async () => {
  for (let round = 0; round < 8; round += 1) {
    await page.keyboard.press('Escape')
    await sleep(300)
    if ((await page.locator('.theater').count()) === 0 && (await page.locator('.detail-modal').count()) === 0) break
  }
  if (await page.locator('.theater').count()) {
    await page.locator('.theater-back').click({ force: true }).catch(() => undefined)
    await sleep(800)
  }
}

const settleSearch = async () => {
  await page.waitForFunction(
    () => document.querySelector('.search-view')?.getAttribute('aria-busy') === 'false',
    null,
    { timeout: 30_000 },
  )
}

try {
  await resetOverlays()

  // 1. 真实搜索相关性：无关 CMS 目录不应出现；“三体”同名版本不应被压成一张
  await page.fill('.search-input', 'zzz不存在的片名qqq')
  await settleSearch().catch(() => undefined)
  await sleep(800)
  const nonsense = await page.evaluate(() => ({
    cards: document.querySelectorAll('.search-view .poster-card').length,
    empty: Boolean(document.querySelector('.search-view .empty-state')),
    text: document.querySelector('.search-view')?.innerText ?? '',
  }))
  record(
    'nonsense search has no unrelated CMS cards',
    nonsense.cards === 0 && (nonsense.empty || nonsense.text.includes('搜索暂时不可用')),
    `cards=${nonsense.cards}, empty/error=${nonsense.empty}`,
  )

  await page.fill('.search-input', '三体')
  await settleSearch()
  await sleep(800)
  const sameName = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.search-view .poster-card')]
    return {
      cards: cards.length,
      titles: cards.map((node) => node.innerText.replace(/\s+/g, ' ')).slice(0, 8),
      sansha: cards.filter((node) => node.innerText.includes('三体')).length,
    }
  })
  record(
    'same-name versions remain visible',
    sameName.cards >= 2 && sameName.sansha >= 2,
    `${sameName.cards} cards; 三体=${sameName.sansha}`,
  )

  // 2. 设置页：源启停、存储大小、备份导出
  await page.locator('.nav-item', { hasText: /设置|Settings/ }).first().click()
  await page.waitForSelector('.account-sources', { timeout: 15_000 })
  await page.waitForSelector('.settings-source-toggle', { timeout: 15_000 })
  const sourceButton = page.locator('.settings-source-toggle').first()
  const sourceBefore = await sourceButton.getAttribute('aria-pressed')
  const sourceLabelBefore = (await sourceButton.textContent())?.trim()
  await sourceButton.click()
  await page.waitForFunction(
    (previous) => document.querySelector('.settings-source-toggle')?.getAttribute('aria-pressed') !== previous,
    sourceBefore,
    { timeout: 15_000 },
  )
  const sourceAfter = await sourceButton.getAttribute('aria-pressed')
  await sourceButton.click()
  await page.waitForFunction(
    (expected) => document.querySelector('.settings-source-toggle')?.getAttribute('aria-pressed') === expected,
    sourceBefore,
    { timeout: 15_000 },
  )
  const sourceRestored = await sourceButton.getAttribute('aria-pressed')
  record(
    'settings can toggle play source off/on',
    sourceAfter !== sourceBefore && sourceRestored === sourceBefore,
    `${sourceLabelBefore} ${sourceBefore} -> ${sourceAfter} -> ${sourceRestored}`,
  )

  const storageText = await page.locator('.account-backup').innerText()
  record('settings shows local storage size', /本地数据约|of local data/.test(storageText), storageText.replace(/\s+/g, ' ').slice(0, 100))

  let exported = null
  await page.locator('.account-backup .settings-toggle').first().click()
  const exportStatus = page.locator('[data-export-path]')
  await exportStatus.waitFor({ state: 'visible', timeout: 15_000 })
  const exportPath = await exportStatus.getAttribute('data-export-path')
  if (exportPath && existsSync(exportPath)) {
    const payload = JSON.parse(readFileSync(exportPath, 'utf8'))
    exported = Object.keys(payload.data ?? {}).length
    unlinkSync(exportPath)
  }
  record('backup export writes a JSON file without download UI', exported !== null && exported > 0, `${exported ?? 0} keys at ${exportPath ?? 'n/a'}`)

  // 3. 备份导入：写入一个测试条目，reload 后应在我的片单出现
  const importId = 'db-e2e-import-1'
  const importTitle = {
    id: importId,
    name: 'E2E 导入条目',
    mediaType: 'film',
    year: 2024,
    ageRating: '',
    match: 0,
    genres: [],
    synopsis: 'e2e import',
    poster: '',
    hero: '',
    titleStyle: 'condensed',
    titleLines: ['E2E 导入条目'],
    language: '',
    creator: '',
    cast: [],
    addedOrder: 0,
  }
  const importPath = `${OUT}/import-backup.json`
  writeFileSync(
    importPath,
    JSON.stringify({
      app: 'seeworld',
      version: 1,
      data: {
        'jj-my-list': JSON.stringify([importId]),
        'jj-title-cache': JSON.stringify({ [importId]: importTitle }),
        'jj-progress': JSON.stringify({ [importId]: { current: 600, duration: 5400, updatedAt: Date.now() } }),
      },
    }),
  )
  await page.locator('.account-backup input[type=file]').setInputFiles(importPath)
  await page.waitForTimeout(1500)
  await page.locator('.nav-item', { hasText: /我的片单|My List/ }).first().click()
  await page.waitForSelector('.page-view .poster-card', { timeout: 20_000 })
  const importedCards = await page.locator('.page-view .poster-card').count()
  record('backup import restores list title', importedCards === 1, `cards=${importedCards}`)

  // 4. 清缓存保留片单（导入条目的 title-cache 被 pinned 保护）
  await page.locator('.nav-item', { hasText: /设置|Settings/ }).first().click()
  await page.waitForSelector('.account-data')
  const cacheAction = page.locator('.settings-toggle--danger').nth(2)
  await cacheAction.click()
  await page.waitForTimeout(100)
  await Promise.all([page.waitForEvent('domcontentloaded'), cacheAction.click()])
  await page.locator('.nav-item', { hasText: /我的片单|My List/ }).first().click()
  await page.waitForSelector('.page-view .poster-card', { timeout: 20_000 })
  const afterClear = await page.locator('.page-view .poster-card').count()
  record('clear cache keeps pinned list title', afterClear === 1, `cards=${afterClear}`)

  // 5. 播放器帮助、画质选择、PiP 能力检测
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
  await page.mouse.move(640, 100)
  await sleep(400)
  await page.getByRole('button', { name: /键盘快捷键|Keyboard shortcuts/ }).first().click()
  await page.waitForSelector('.theater-help', { timeout: 10_000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.theater-help', { state: 'detached', timeout: 10_000 })
  record('player help opens and closes', true)

  const quality = await page.evaluate(() => {
    const select = document.querySelector('.quality-select')
    return select ? { exists: true, options: select.options.length, value: select.value } : { exists: false }
  })
  if (quality.exists) {
    const options = await page.locator('.quality-select option').evaluateAll((nodes) =>
      nodes.map((node) => node.value),
    )
    const target = options.find((value) => value !== 'auto') ?? 'auto'
    await page.locator('.quality-select').selectOption(target)
    await sleep(600)
    const selected = await page.locator('.quality-select').inputValue()
    await page.locator('.quality-select').selectOption('auto')
    await sleep(300)
    record('quality selector changes and restores auto', selected === target, `${target} selected`)
  } else {
    record('quality selector conditional on multi-level stream', true, 'source has one level; control hidden')
  }

  await page.locator('.theater-back').click()
  await page.waitForSelector('.theater', { state: 'detached', timeout: 15_000 })

  writeFileSync(`${OUT}/new-features.json`, JSON.stringify({ results, nonsense, sameName, sourceBefore, sourceAfter, sourceRestored, exported }, null, 2))
} catch (error) {
  record('new feature run', false, String(error).slice(0, 400))
} finally {
  // 恢复 localStorage 快照
  try {
    await page.evaluate((data) => {
      const keys = []
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (key?.startsWith('jj-')) keys.push(key)
      }
      for (const key of keys) localStorage.removeItem(key)
      for (const [key, value] of Object.entries(data)) localStorage.setItem(key, value)
    }, snapshot)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.poster-card', { timeout: 30_000 }).catch(() => undefined)
  } catch (error) {
    console.error('[e2e] restore failed', error)
  }
  await browser.close()
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}