/**
 * 真实应用：备份导出必须走 Rust 原生命令，不触发 WebView2 下载提示。
 * 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run dev
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9223')
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().includes('localhost:1420'))
if (!page) throw new Error('app page not found')

let downloads = 0
page.on('download', () => {
  downloads += 1
})

try {
  for (let round = 0; round < 6; round += 1) {
    await page.keyboard.press('Escape')
    await new Promise((resolve) => setTimeout(resolve, 300))
    if ((await page.locator('.theater').count()) === 0) break
  }
  if (await page.locator('.theater').count()) {
    await page.locator('.theater-back').click({ force: true }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 600))
  }

  await page.locator('.nav-item', { hasText: /设置|Settings/ }).first().click()
  await page.waitForSelector('.account-backup', { timeout: 15_000 })
  await page.locator('.account-backup .settings-toggle').first().click()
  const status = page.locator('[data-export-path]')
  await status.waitFor({ state: 'visible', timeout: 15_000 })
  const path = await status.getAttribute('data-export-path')
  const exists = Boolean(path && existsSync(path))
  let keys = 0
  if (exists && path) {
    const payload = JSON.parse(readFileSync(path, 'utf8'))
    keys = Object.keys(payload.data ?? {}).length
    unlinkSync(path)
  }
  const ok = downloads === 0 && exists && keys > 0
  console.log(`[${ok ? 'PASS' : 'FAIL'}] native export without download UI — downloads=${downloads}, file=${exists}, keys=${keys}`)
  if (path) console.log(`[e2e] exported path: ${path}`)
  if (!ok) process.exitCode = 1
} finally {
  await browser.close()
}