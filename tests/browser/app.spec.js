import { test, expect } from '@playwright/test';
import { installFakeBLE } from '../fake-ble.js';
import { defaults, searchURL, GOOGLE } from '../../dist/core.js';

async function setup(page, options = {}, settings = {}) {
  await page.addInitScript(installFakeBLE, options);
  await page.addInitScript(value => {
    if (!localStorage.getItem('bvb.settings.v2')) localStorage.setItem('bvb.settings.v2', JSON.stringify(value));
  }, { ...defaults, os: 'windows', layout: 'jis', ...settings });
  await page.goto('/');
}
async function connect(page) { await page.locator('#connect').click(); await expect(page.locator('#connection-label')).toHaveText('接続済み'); }
async function operationCount(page, count) { await expect.poll(() => page.evaluate(() => bleMock.operations.length)).toBe(count); }
async function finish(page) { await expect(page.locator('#message')).toContainText('HIDキー操作を送出'); }

test('OS is explicitly selected; first-use theme follows device and saved settings persist', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' }); await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#settings-open').click(); await expect(page.locator('#os')).toHaveValue('');
  await page.locator('#os').selectOption('mac'); await page.locator('#layout').selectOption('us');
  await page.locator('#theme').selectOption('light'); await page.locator('#launch-ms').fill('4000');
  await page.locator('#phrase').fill('ブラウザを開く'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#settings-open').click(); await expect(page.locator('#os')).toHaveValue('mac');
  await expect(page.locator('#layout')).toHaveValue('us'); await expect(page.locator('#launch-ms')).toHaveValue('4000');
  await expect(page.locator('#phrase')).toHaveValue('ブラウザを開く');
});

test('disconnected controls, connect and disconnect', async ({ page }) => {
  await setup(page); await page.locator('#text').fill('hello');
  await expect(page.locator('#send')).toBeDisabled(); await expect(page.locator('#chrome')).toBeDisabled();
  await connect(page); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#connect').click(); await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('#connection-label')).toHaveText('未接続');
});

test('Chrome opens without text and never sends a nonempty body', async ({ page }) => {
  await setup(page); await connect(page);
  await expect(page.locator('#send')).toBeDisabled(); await page.locator('#chrome').click(); await finish(page);
  await page.locator('#text').fill('本文は送らない'); await page.locator('#chrome').click(); await finish(page);
  const ops = await page.evaluate(() => bleMock.operations);
  expect(ops.map(o => o.op)).toEqual([1, 1]); expect(ops.map(o => o.bytes)).toEqual([[], []]);
  await expect(page.locator('#text')).toHaveValue('本文は送らない');
});

for (const os of ['mac', 'windows']) for (const enter of [false, true]) {
  test(`search wire data: ${os}, Enter ${enter}`, async ({ page }) => {
    await setup(page, {}, { os, enter }); await connect(page);
    const text = '日本語 abc 123 :/?=% &+# 😀\n次の行';
    await page.locator('#text').fill(text); await page.locator('#send').click(); await finish(page);
    const [op] = await page.evaluate(() => bleMock.operations);
    expect(op.op).toBe(2); expect(op.os).toBe(os === 'mac' ? 2 : 1); expect(op.enter).toBe(Number(enter));
    expect(new TextDecoder().decode(Uint8Array.from(op.bytes))).toBe(searchURL(text));
  });
}

test('4096-byte URL boundary is dynamic, not textarea character limit', async ({ page }) => {
  await setup(page); await connect(page);
  await page.locator('#text').fill('a'.repeat(4096 - GOOGLE.length));
  await expect(page.locator('#capacity')).toHaveText('4096 / 4096 B'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#text').fill('a'.repeat(4097 - GOOGLE.length));
  await expect(page.locator('#send')).toBeDisabled(); await expect(page.locator('#capacity')).toHaveText('4097 / 4096 B');
  await page.locator('#text').fill('漢'.repeat(500)); await expect(page.locator('#send')).toBeDisabled();
});

test('legacy keeps Alt+X off Chrome search and rejects Mac Unicode', async ({ page }) => {
  await setup(page, {}, { target: 'legacy' }); await connect(page);
  await page.locator('#text').fill('漢'); await page.locator('#send').click(); await finish(page);
  expect(await page.evaluate(() => bleMock.operations[0].op)).toBe(3);
  await page.locator('#settings-open').click(); await page.locator('#os').selectOption('mac');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#send')).toBeDisabled(); await expect(page.locator('#capacity')).toContainText('Windows専用');
});

test('busy survives acceptance; rapid clicks and edited input cannot interrupt', async ({ page }) => {
  await setup(page, { hold: true }); await connect(page); await page.locator('#text').fill('first');
  await page.locator('#send').evaluate(el => { el.click(); el.click(); }); await operationCount(page, 1);
  await expect(page.locator('#message')).toHaveText('ESP32で受付');
  await expect(page.locator('#send')).toBeDisabled(); await expect(page.locator('#chrome')).toBeDisabled();
  await page.locator('#text').fill('クロームを開いて'); await page.waitForTimeout(1300);
  expect(await page.evaluate(() => bleMock.operations.length)).toBe(1);
  await page.evaluate(() => bleMock.finish()); await finish(page); await page.waitForTimeout(1300);
  expect(await page.evaluate(() => bleMock.operations.length)).toBe(1);
});

test('phrase only matches the full field after stability and is not replayed', async ({ page }) => {
  await setup(page); await connect(page);
  await page.locator('#text').fill('今日はクロームを開いて調べたい'); await page.waitForTimeout(1300);
  expect(await page.evaluate(() => bleMock.operations.length)).toBe(0);
  await page.locator('#text').fill(' ｸﾛｰﾑ を 開いて。');
  await page.waitForTimeout(500); expect(await page.evaluate(() => bleMock.operations.length)).toBe(0);
  await operationCount(page, 1); await finish(page);
  await page.locator('#text').fill('クロームを開いて！！'); await page.waitForTimeout(1300);
  await page.locator('#send').click(); expect(await page.evaluate(() => bleMock.operations.length)).toBe(1);
  expect(await page.evaluate(() => bleMock.operations[0].bytes)).toEqual([]);
  await page.locator('#clear').click(); await page.locator('#text').fill('クロームを開いて'); await operationCount(page, 2);
});

test('composition blocks phrase evaluation and button sends', async ({ page }) => {
  await setup(page); await connect(page);
  await page.locator('#text').dispatchEvent('compositionstart'); await page.locator('#text').fill('クロームを開いて');
  await expect(page.locator('#send')).toBeDisabled(); await page.waitForTimeout(1300);
  expect(await page.evaluate(() => bleMock.operations.length)).toBe(0);
  await page.locator('#text').dispatchEvent('compositionend'); await operationCount(page, 1);
});

test('hidden and disconnected phrases never fire on return or reconnect', async ({ page }) => {
  await setup(page); await page.locator('#text').fill('クロームを開いて'); await connect(page); await page.waitForTimeout(1300);
  expect(await page.evaluate(() => bleMock.operations.length)).toBe(0);
  await page.locator('#clear').click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.locator('#text').fill('クロームを開いて'); await page.waitForTimeout(1300);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1300); expect(await page.evaluate(() => bleMock.operations.length)).toBe(0);
});

test('a failed phrase preserves text without retry', async ({ page }) => {
  await setup(page, { disconnect: true }); await connect(page); await page.locator('#text').fill('クロームを開いて');
  await operationCount(page, 1); await expect(page.locator('#message')).toContainText('結果不明');
  await expect(page.locator('#text')).toHaveValue('クロームを開いて');
  await connect(page); await page.waitForTimeout(1300); expect(await page.evaluate(() => bleMock.operations.length)).toBe(1);
});

test('old firmware receives no new command or text', async ({ page }) => {
  await setup(page, { old: true }); await page.locator('#connect').click();
  await expect(page.locator('#message')).toContainText('更新'); await expect(page.locator('#chrome')).toBeDisabled();
  expect(await page.evaluate(() => bleMock.frames.length)).toBe(0);
});

for (const theme of ['light', 'dark']) test(`capture ${theme} at phone and narrow widths`, async ({ page }) => {
  await setup(page, {}, { theme }); await connect(page);
  await page.locator('#text').fill('週末の小さな旅\n海が見えるカフェを探す。');
  await page.screenshot({ path: `docs/screenshots/${theme}.png`, fullPage: true });
  await page.locator('#settings-open').click();
  await page.screenshot({ path: `docs/screenshots/${theme}-settings.png`, fullPage: true });
  await page.locator('#settings-close').click();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
