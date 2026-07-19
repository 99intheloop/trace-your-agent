/**
 * docs/screenshots/ 的截图脚本(本机 Chrome + 本地服务)。
 *
 * 用法:
 *   TYA_HOME=<数据目录> npx tya serve --no-open --port 4777
 *   node scripts/screenshot.mjs           # 全部
 *   SHOTS=02,03 node scripts/screenshot.mjs  # 只截指定编号
 *
 * 隐私:截图前注入 DOM 级脱敏——sessions 表格 CWD 列整列遮蔽,命中词表的
 * 文本变灰块(搜索命中行整行隐藏)。**词表不进仓库**:默认只含占位词,真实
 * 词表放 scripts/.denylist.local(已被 gitignore,一行一个,支持正则)或用
 * 环境变量 TYA_REDACT_DENY 传一个正则。
 * 注意:01-sessions.png 当前为手工脱敏版,本脚本默认跳过(SHOTS 不含 01)。
 */
import { readFileSync, existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.TYA_URL ?? 'http://127.0.0.1:4777';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const DETAIL_ID =
  process.env.TYA_DETAIL_SESSION ?? 'session_95663159-68fe-4ba9-8a33-28a4b8afe3ec';
const ONLY = process.env.SHOTS?.split(',');

/** 脱敏词表:env 优先,其次 gitignore 的本地文件,兜底占位(不匹配任何内容)。 */
function loadDenylist() {
  if (process.env.TYA_REDACT_DENY !== undefined) return process.env.TYA_REDACT_DENY;
  const localFile = new URL('./.denylist.local', import.meta.url).pathname;
  if (existsSync(localFile)) {
    const terms = readFileSync(localFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    if (terms.length > 0) return terms.join('|');
  }
  return 'a^'; // 永不匹配
}
const DENYLIST = new RegExp(loadDenylist(), 'i');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu', '--force-color-profile=srgb'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (n) => ONLY === undefined || ONLY.includes(n);

async function redact() {
  await page.evaluate((denySrc) => {
    const deny = new RegExp(denySrc, 'i');
    const style = document.createElement('style');
    style.textContent =
      '.tya-redact{background:#5b6472!important;color:transparent!important;' +
      'border-radius:3px;text-shadow:none!important}' +
      '.tya-hide{display:none!important}';
    document.head.appendChild(style);
    // sessions 表格:CWD 列(第 4 列)整列遮蔽
    document.querySelectorAll('.tbl tbody tr').forEach((tr) => {
      const td = tr.querySelectorAll('td')[3];
      if (td) td.classList.add('tya-redact');
    });
    // 搜索命中行:命中即整行隐藏(灰色色块夹在列表里太扎眼)
    document.querySelectorAll('.search-hit').forEach((el) => {
      if (deny.test(el.textContent ?? '')) el.classList.add('tya-hide');
    });
    // 其余全部按叶子元素精确遮蔽(文本变灰块,布局不受影响)
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length === 0 && deny.test(el.textContent ?? '')) {
        el.classList.add('tya-redact');
      }
    });
  }, DENYLIST.source);
}

async function shot(name) {
  await redact();
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`✓ ${name}.png`);
}

// 2. cwd 级联(真实鼠标点击第一列项 → 第二列)
if (want('02')) {
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.tbl tbody tr', { timeout: 8000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('目录'))
      ?.click();
  });
  await sleep(400);
  const clicked = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.cascade-item')].find((i) =>
      i.textContent?.includes('Users/'),
    );
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (clicked !== null) await page.mouse.click(clicked.x, clicked.y);
  await sleep(600);
  await shot('02-cwd-cascade');
  await page.keyboard.press('Escape');
  await sleep(200);
}

// 3. 搜索下拉(命中字段徽章 + 平台徽章 + 高亮)
if (want('03')) {
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.tbl tbody tr', { timeout: 8000 });
  await page.type('input[type="search"]', 'AGENTS');
  await page.waitForSelector('.search-hit', { timeout: 8000 });
  await sleep(400);
  await shot('03-search-dropdown');
}

// 4. Enter 提交 → 表格过滤(chip + N 命中徽章)
if (want('04')) {
  if ((await page.$('input[type="search"]')) === null) {
    await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle0' });
  }
  await page.evaluate(() => {
    const input = document.querySelector('input[type="search"]');
    if (input instanceof HTMLInputElement && input.value === '') {
      // 直接走 URL 同步恢复,比模拟输入更稳
      window.history.replaceState(null, '', '/sessions?spanQ=AGENTS');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  });
  await page.goto(`${BASE}/sessions?spanQ=AGENTS`, { waitUntil: 'networkidle0' });
  await sleep(500);
  await shot('04-search-filter');
}

// 5. session 详情:选中一个 TOOL span,右侧详情面板展开
if (want('05')) {
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
}

await browser.close();
console.log('done → docs/screenshots/');
