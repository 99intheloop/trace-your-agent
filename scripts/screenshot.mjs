/**
 * docs/screenshots/ 的截图脚本(本机 Chrome + 本地服务)。
 *
 * 用法:
 *   TYA_HOME=<数据目录> npx tya serve --no-open --port 4777
 *   node scripts/screenshot.mjs
 *
 * 覆盖功能点:sessions 总览 / 平台 tab / 过滤栏 / cwd 级联 / 搜索下拉 /
 * spanQ 表格过滤 / session 详情(span 树 + 选中详情面板)。
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.TYA_URL ?? 'http://127.0.0.1:4777';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
// 选一个数据丰富的真实 session 做详情页(可被 env 覆盖)
const DETAIL_ID =
  process.env.TYA_DETAIL_SESSION ?? 'session_a636da29-c543-4cbe-820c-ddb26c209a81';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu', '--force-color-profile=srgb'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

async function shot(name) {
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`✓ ${name}.png`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. sessions 总览(平台 tab + 过滤栏 + 聚合卡片 + 表格)
await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.tbl tbody tr', { timeout: 8000 });
await sleep(400);
await shot('01-sessions');

// 2. cwd 级联展开(真实鼠标点击第一列项 → 第二列)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('目录'),
  );
  btn?.click();
});
await sleep(400);
const clicked = await page.evaluate(() => {
  const target = [...document.querySelectorAll('.cascade-item')].find(
    (i) => i.textContent?.includes('Users/'),
  );
  if (!target) return null;
  const r = target.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (clicked !== null) await page.mouse.click(clicked.x, clicked.y);
await sleep(600);
await shot('02-cwd-cascade');

// 关掉级联
await page.keyboard.press('Escape');
await page.evaluate(() => document.body.click());
await sleep(200);

// 3. 搜索下拉(命中字段徽章 + 平台徽章 + 高亮 + 项目名)
await page.type('input[type="search"]', 'AGENTS');
await page.waitForSelector('.search-hit', { timeout: 8000 });
await sleep(400);
await shot('03-search-dropdown');

// 4. Enter 提交 → 表格过滤(chip + N 命中徽章)
await page.keyboard.press('Enter');
await sleep(800);
await shot('04-search-filter');

// 5. session 详情:选中一个 TOOL span,右侧详情面板展开
await page.goto(`${BASE}/sessions/${encodeURIComponent(DETAIL_ID)}`, {
  waitUntil: 'networkidle0',
});
await page.waitForSelector('.span-row', { timeout: 8000 });
await sleep(500);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.span-row')];
  const toolRow = rows.find((r) => r.textContent?.includes('TOOL'));
  (toolRow ?? rows[2] ?? rows[0])?.click();
});
await sleep(600);
await shot('05-session-detail');

await browser.close();
console.log('done → docs/screenshots/');
