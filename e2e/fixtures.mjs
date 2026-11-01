/**
 * 受控 UI fixture 回归（不启动 Tauri、不访问真实豆瓣/CMS）。
 *
 * 前置：npm --prefix prototype run build && npm --prefix prototype run preview -- --port 1420
 * 运行：node e2e/fixtures.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const EDGE =
  process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP_URL = process.env.APP_URL ?? 'http://localhost:1420'
const OUT = 'e2e/artifacts'
mkdirSync(OUT, { recursive: true })

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const context = await browser.newContext({ viewport: { width: 1292, height: 864 } })

await context.addInitScript(() => {
  window.__fixtureMode = 'normal'
  window.__fixtureCommands = []
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (url) => url,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke: async (command, args) => {
      window.__fixtureCommands.push({ command, args })
      if (command === 'play_sources') {
        return [{ key: 'fixture', name: 'Fixture Source', priority: 1, enabled: true }]
      }
      if (command === 'douban_list' || command === 'douban_recommend') return []
      if (command === 'douban_detail') throw 'fixture detail unavailable'
      if (command === 'douban_suggest') {
        if (window.__fixtureMode === 'errors') throw 'fixture suggest timeout'
        return [
          { id: '1001', title: '三体', subTitle: '', img: '', year: '2023', episode: '30', kind: 'movie', url: '' },
          { id: '1002', title: '三体', subTitle: '', img: '', year: '2022', episode: '15', kind: 'movie', url: '' },
          { id: '1003', title: '三体', subTitle: '', img: '', year: '2028', episode: '', kind: 'movie', url: '' },
          { id: '1004', title: '三体', subTitle: '', img: '', year: '2030', episode: '', kind: 'movie', url: '' },
        ]
      }
      if (command === 'play_search') {
        if (window.__fixtureMode === 'errors') {
          return { items: [], errors: [{ sourceKey: 'fixture', message: 'fixture timeout' }], sourceCount: 1 }
        }
        return {
          items: [
            { sourceKey: 'fixture', vodId: '1', name: '三体', pic: '', year: '2023', typeName: '国产剧', remarks: '', actor: '', director: '', area: '', lang: '', lineNames: [] },
            { sourceKey: 'fixture', vodId: '2', name: '追踪再现', pic: '', year: '2022', typeName: '剧情片', remarks: '', actor: '', director: '', area: '', lang: '', lineNames: [] },
            { sourceKey: 'fixture', vodId: '3', name: '三体[电影解说]', pic: '', year: '2023', typeName: '电影解说', remarks: '', actor: '', director: '', area: '', lang: '', lineNames: [] },
          ],
          errors: [],
          sourceCount: 1,
        }
      }
      if (command.endsWith('get_version')) return '0.1.0'
      if (command.endsWith('is_maximized') || command.endsWith('is_fullscreen')) return false
      if (command.endsWith('listen')) return 1
      return null
    },
  }
})

const page = await context.newPage()
const settleSearch = async () => {
  await page.waitForFunction(
    () => document.querySelector('.search-view')?.getAttribute('aria-busy') === 'false',
    null,
    { timeout: 20_000 },
  )
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.search-input')

  await page.fill('.search-input', '三体')
  await settleSearch()
  await page.waitForTimeout(400)
  const normal = await page.evaluate(() => ({
    count: document.querySelectorAll('.search-view .poster-card').length,
    text: document.querySelector('.search-view')?.innerText ?? '',
  }))
  record(
    'search filters unrelated CMS catalog and keeps all same-name versions',
    normal.count === 4 && !normal.text.includes('追踪再现') && !normal.text.includes('解说'),
    `${normal.count} cards; junk/variant hidden=${!normal.text.includes('追踪再现') && !normal.text.includes('解说')}`,
  )

  await page.evaluate(() => {
    window.__fixtureMode = 'errors'
  })
  await page.fill('.search-input', 'zzz不存在')
  await settleSearch()
  await page.waitForTimeout(400)
  const failed = await page.evaluate(() => ({
    empty: Boolean(document.querySelector('.search-view .empty-state')),
    alert: Boolean(document.querySelector('.search-view [role="alert"]')),
    text: document.querySelector('.search-view')?.innerText ?? '',
  }))
  record(
    'all-source failure shows error state instead of no-results',
    failed.empty && failed.alert && failed.text.includes('搜索暂时不可用'),
    failed.text.slice(0, 120).replace(/\s+/g, ' '),
  )

  // 清缓存保留片单：先写入一个只有 title cache 才能渲染的源条目。
  await page.evaluate(() => {
    const id = 'ps-fixture-999999'
    const title = {
      id,
      name: 'Fixture 保留条目',
      mediaType: 'film',
      year: 2024,
      ageRating: '',
      match: 0,
      genres: [],
      synopsis: 'fixture only',
      poster: '',
      hero: '',
      titleStyle: 'condensed',
      titleLines: ['Fixture 保留条目'],
      language: '',
      creator: '',
      cast: [],
      addedOrder: 0,
    }
    localStorage.setItem('jj-title-cache', JSON.stringify({ [id]: title }))
    localStorage.setItem('jj-my-list', JSON.stringify([id]))
    localStorage.setItem('jj-progress', JSON.stringify({ [id]: { current: 120, duration: 1000, updatedAt: Date.now() } }))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.nav-item', { hasText: /我的片单|My List/ }).first().click()
  await page.waitForSelector('.page-view .poster-card')
  const before = await page.locator('.page-view .poster-card').count()

  await page.locator('.nav-item', { hasText: /设置|Settings/ }).first().click()
  await page.waitForSelector('.account-data')
  const cacheAction = page.locator('.settings-toggle--danger').nth(2)
  await cacheAction.click()
  await page.waitForTimeout(100)
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    cacheAction.click(),
  ])
  await page.locator('.nav-item', { hasText: /我的片单|My List/ }).first().click()
  await page.waitForSelector('.page-view .poster-card')
  const after = await page.locator('.page-view .poster-card').count()
  record(
    'clear cache keeps pinned list title renderable',
    before === 1 && after === 1,
    `before=${before}, after=${after}`,
  )
} catch (error) {
  record('fixture run', false, String(error).slice(0, 300))
} finally {
  await browser.close()
  writeFileSync(`${OUT}/fixtures.json`, JSON.stringify({ results }, null, 2))
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n[fixture] ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}