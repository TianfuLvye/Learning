/**
 * 端到端冒烟测试：启动真实后端（托管构建产物）+ 模拟 DeepSeek 服务，用无头浏览器验证界面。
 *
 *   npm run build && npm run e2e
 *
 * 验证内容：Markdown 渲染、本地图片、相对链接跳转、字号持久化、
 * 选择题与挖空的完整作答流程、AI 未配置提示、桌面与移动端布局。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
import { createApp } from '../server/app';
import { loadConfig } from '../server/config';

const ROOT = process.cwd();
const PORT = 3399;
const MOCK_PORT = 3398;
const OUT = path.join(ROOT, 'scripts', 'screenshots');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function launchChrome(): Promise<Browser> {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean) as string[];
  for (const executablePath of candidates) {
    try {
      await fs.access(executablePath);
      return await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
      });
    } catch (err) {
      console.warn(`  启动 ${executablePath} 失败：${(err as Error).message}`);
    }
  }
  throw new Error('找不到可用的 Chromium 可执行文件，请设置 CHROME_PATH');
}

const consoleErrors: string[] = [];

function watchPage(page: Page) {
  // 资源加载失败按 URL 单独记录：外部图片在离线环境中加载失败属于预期，不计为错误
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('response', (res) => {
    const url = new URL(res.url());
    // 入门指南中故意包含 <img src="x" onerror=...> 用于演示安全过滤，其 404 属于预期
    const expected = url.pathname === '/api/asset' && url.searchParams.get('path') === 'x';
    if (res.status() >= 400 && url.hostname === '127.0.0.1' && !expected) consoleErrors.push(`HTTP ${res.status()} ${url.pathname}${url.search}`);
  });
}

const clickByText = async (page: Page, selector: string, text: string) => {
  const handle: ElementHandle<Element> = await page.evaluateHandle(
    (sel, txt) => [...document.querySelectorAll(sel)].find((el) => (el.textContent ?? '').includes(txt)) ?? null,
    selector,
    text,
  ) as unknown as ElementHandle<Element>;
  const el = handle.asElement() as ElementHandle<Element> | null;
  if (!el) throw new Error(`找不到文本为「${text}」的 ${selector}`);
  await el.click();
  return true;
};

const waitForText = (page: Page, text: string, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);


/** 异常场景：无效 JSON、取消请求、未配置 API Key（使用独立的后端实例与假 DeepSeek 服务） */
async function errorScenarios(browser: Browser, clientDir: string) {
  const http = await import('node:http');
  let mode: 'bad' | 'slow' = 'bad';
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const reply = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '这不是 JSON {{{' }, finish_reason: 'stop' }] }));
      };
      if (mode === 'slow') setTimeout(() => !res.destroyed && reply(), 8000);
      else reply();
    });
  });
  await new Promise<void>((r) => fake.listen(3397, '127.0.0.1', () => r()));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdlearn-e2e-err-'));
  await fs.cp(path.join(ROOT, 'learn'), path.join(tmp, 'learn'), {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith('.'),
  });
  const mk = (port: number, apiKey: string) => {
    const cfg = loadConfig({
      port,
      staticDir: clientDir,
      learnDir: path.join(tmp, 'learn'),
      cacheDir: path.join(tmp, `.cache-${port}`),
      ai: { apiKey, baseUrl: 'http://127.0.0.1:3397', timeoutMs: 20000, maxRetries: 1 },
    });
    const ctx = createApp(cfg);
    return { ctx, server: ctx.app.listen(port) };
  };
  const withKey = mk(3396, 'e2e-key');
  const noKey = mk(3395, '');
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.setViewport({ width: 1440, height: 900 });

  const openPractice = async (base: string) => {
    await page.goto(base, { waitUntil: 'networkidle2' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.page__body .md', { timeout: 15000 });
    await clickByText(page, '.segmented button', '练习');
    await waitForText(page, '开始生成选择题', 10000);
  };

  try {
    console.log('\n▸ 异常处理：AI 返回无效 JSON');
    mode = 'bad';
    await openPractice('http://127.0.0.1:3396');
    await clickByText(page, '.btn--primary', '开始生成选择题');
    await page.waitForSelector('.banner--error', { timeout: 20000 });
    const bad = await page.evaluate(() => ({
      text: document.querySelector('.banner--error')?.textContent ?? '',
      retry: [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('重试')),
      alive: Boolean(document.querySelector('.topbar')),
    }));
    check('无效 JSON 显示友好错误且页面不崩溃', bad.alive && bad.text.includes('JSON') && bad.retry, bad.text);
    await page.screenshot({ path: path.join(OUT, '13-error-invalid-json.png') });

    console.log('\n▸ 异常处理：取消生成');
    mode = 'slow';
    await clickByText(page, 'button', '重试');
    await waitForText(page, '正在依据', 5000);
    await clickByText(page, '.state .btn', '取消');
    await waitForText(page, '开始生成选择题', 5000);
    const cancelled = await page.evaluate(() => document.querySelectorAll('.banner--error').length === 0);
    check('可以取消正在进行的生成请求', cancelled);

    console.log('\n▸ 异常处理：未配置 API Key');
    await openPractice('http://127.0.0.1:3395');
    const noKeyState = await page.evaluate(() => ({
      banner: document.body.innerText.includes('未配置 DeepSeek API Key'),
      disabled: [...document.querySelectorAll<HTMLButtonElement>('.btn--primary')].some(
        (b) => (b.textContent ?? '').includes('开始生成') && b.disabled,
      ),
    }));
    check('未配置 API Key 时显示配置提示并禁用生成', noKeyState.banner && noKeyState.disabled, JSON.stringify(noKeyState));
    await clickByText(page, '.segmented button', '阅读');
    await page.waitForSelector('.page__body .md', { timeout: 10000 });
    check('未配置 API Key 时阅读功能正常', true);
    await page.screenshot({ path: path.join(OUT, '14-no-api-key.png') });
    check('异常场景中没有页面脚本错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } finally {
    await page.close();
    for (const s of [withKey, noKey]) {
      await s.ctx.events.close();
      s.server.close();
    }
    fake.closeAllConnections();
    fake.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  // 1. 构建产物 + 真实后端（生产模式托管静态资源）
  const clientDir = path.join(ROOT, 'dist', 'client');
  if (!(await fs.stat(clientDir).catch(() => null))) throw new Error('请先运行 npm run build');

  const mock: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', path.join(ROOT, 'scripts', 'mock-deepseek.ts')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'inherit',
  });

  // 使用临时目录中的 learn/ 副本与独立缓存，避免污染真实学习进度
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdlearn-e2e-'));
  await fs.cp(path.join(ROOT, 'learn'), path.join(tmp, 'learn'), {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith('.progress') && !path.basename(src).startsWith('.scores'),
  });
  const config = loadConfig({
    port: PORT,
    staticDir: clientDir,
    learnDir: path.join(tmp, 'learn'),
    cacheDir: path.join(tmp, '.cache'),
    ai: { apiKey: 'e2e-test-key', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, timeoutMs: 15000, maxRetries: 1 },
  });
  const { app, events } = createApp(config);
  events.watch(config.learnDir);
  const server = app.listen(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await launchChrome();
  const page = await browser.newPage();
  watchPage(page);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  try {
    console.log('\n▸ 阅读模式与 Markdown 渲染');
    await page.goto(base, { waitUntil: 'networkidle2' });
    await clickByText(page, '.tree__label', '入门指南');
    await waitForText(page, '入门指南');
    await page.screenshot({ path: path.join(OUT, '01-reading.png') });

    // 阅读模式按块分页，因此逐跨页收集所有已渲染的格式
    const scanSpread = () =>
      page.evaluate(() => {
        // 同时检查左右两页
        const wrap = document.createElement('div');
        for (const el of document.querySelectorAll('.page__body .md')) wrap.appendChild(el.cloneNode(true));
        const md = wrap;
        return {
          h1: Boolean(md?.querySelector('h1')),
          table: Boolean(md?.querySelector('table th')),
          code: Boolean(md?.querySelector('pre code')),
          inlineCode: Boolean(md?.querySelector('p code')),
          taskList: Boolean(md?.querySelector('.task-list-item input[type=checkbox]')),
          del: Boolean(md?.querySelector('del')),
          blockquote: Boolean(md?.querySelector('blockquote')),
          hr: Boolean(md?.querySelector('hr')),
          img: Boolean(md?.querySelector('img')),
          details: Boolean(md?.querySelector('details')),
          scriptTag: Boolean(document.querySelector('.page__body script')),
          jsHref: [...document.querySelectorAll('.page__body a')].some((a) =>
            (a.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'),
          ),
          pages: document.querySelectorAll('.page').length,
        };
      });

    const merged = {
      h1: false, table: false, code: false, inlineCode: false, taskList: false,
      del: false, blockquote: false, hr: false, img: false, details: false,
      scriptTag: false, jsHref: false, pages: 0,
    };
    let imgLoaded = false;
    let spreadIndex = 0;
    const overflowSpreads: number[] = [];
    for (;;) {
      const spread = await scanSpread();
      for (const key of Object.keys(spread) as Array<keyof typeof spread>) {
        if (typeof spread[key] === 'boolean' && typeof merged[key] === 'boolean') {
          (merged[key] as boolean) = (merged[key] as boolean) || (spread[key] as boolean);
        }
      }
      merged.pages = Math.max(merged.pages, spread.pages);
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.page__body')].some((b) => b.scrollHeight - b.clientHeight > 2),
      );
      if (clipped) overflowSpreads.push(spreadIndex + 1);
      imgLoaded = imgLoaded || (await page.evaluate(async () => {
        const img = document.querySelector('.page__body img') as HTMLImageElement | null;
        if (!img) return false;
        if (!img.complete) await new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
        return img.naturalWidth > 0;
      }));
      const nextDisabled = await page.$$eval('button[aria-label="下一页"]', (els) => (els[0] as HTMLButtonElement).disabled);
      if (nextDisabled || spreadIndex > 20) break;
      await page.click('button[aria-label="下一页"]');
      await new Promise((r) => setTimeout(r, 180));
      spreadIndex++;
    }
    const rendered = merged as Record<keyof typeof merged, boolean | number>;
    console.log(`  （共翻过 ${spreadIndex + 1} 个跨页）`);
    check('渲染一级标题/段落/加粗等基础格式', Boolean(rendered.h1));
    check('渲染表格', Boolean(rendered.table));
    check('渲染代码块与行内代码', Boolean(rendered.code) && Boolean(rendered.inlineCode));
    check('渲染任务列表', Boolean(rendered.taskList));
    check('渲染删除线与引用块', Boolean(rendered.del) && Boolean(rendered.blockquote));
    check('渲染分割线与安全 HTML（details）', Boolean(rendered.hr) && Boolean(rendered.details));
    check('渲染图片', Boolean(rendered.img));
    check('移除 Markdown 中的 <script>', !rendered.scriptTag);
    check('移除 javascript: 危险链接', !rendered.jsHref);
    check('双页阅读布局', Number(rendered.pages) >= 2, `pages=${rendered.pages}`);

    check('本地相对路径图片可加载（/api/asset）', imgLoaded);
    check('分页后每页内容完整显示（无块被裁切）', overflowSpreads.length === 0, `溢出跨页：${overflowSpreads.join(',')}`);

    console.log('\n▸ 翻页与阅读设置');
    const before = await page.$eval('.book__progress', (el) => el.textContent ?? '');
    await page.click('button[aria-label="上一页"]');
    await new Promise((r) => setTimeout(r, 500));
    const after = await page.$eval('.book__progress', (el) => el.textContent ?? '');
    check('翻页按钮生效', before !== after, `${before} → ${after}`);

    await page.click('.icon-btn[title="阅读设置"]');
    await page.waitForSelector('.popover input[type=range]', { timeout: 5000 });
    await page.evaluate(() => {
      const input = document.querySelector('.popover input[type=range]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '23');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const fontSizeApplied = await page.$eval('.md', (el) => getComputedStyle(el).fontSize);
    check('调整字号立即生效', fontSizeApplied === '23px', fontSizeApplied);
    await page.screenshot({ path: path.join(OUT, '02-settings.png') });

    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.md', { timeout: 10000 });
    const fontSizeAfterReload = await page.$eval('.md', (el) => getComputedStyle(el).fontSize);
    check('刷新后字号设置仍然保留', fontSizeAfterReload === '23px', fontSizeAfterReload);

    console.log('\n▸ 相对链接跳转');
    // 字号变化后会重新分页，逐页查找该链接
    for (let i = 0; i < 30; i++) {
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('.page__body .md a')].some((a) => (a.textContent ?? '').includes('TCP 协议')),
      );
      if (found) break;
      await page.click('button[aria-label="下一页"]');
      await new Promise((r) => setTimeout(r, 150));
    }
    await clickByText(page, '.page__body .md a', 'TCP 协议');
    await waitForText(page, '三次握手', 15000);
    const url = await page.evaluate(() => document.querySelector('.topbar__path')?.textContent);
    check('相对链接跳转到其他文档', url === '计算机网络/TCP协议.md', String(url));

    console.log('\n▸ 练习模式：选择题');
    await clickByText(page, '.segmented button', '练习');
    await waitForText(page, '开始生成选择题', 15000);
    await clickByText(page, '.btn--primary', '开始生成选择题');
    await waitForText(page, '单选题', 30000);
    await page.screenshot({ path: path.join(OUT, '03-practice-mcq.png') });

    const beforeSubmit = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        options: document.querySelectorAll('.option').length,
        hasResult: document.querySelectorAll('.option--correct').length,
        leaksAnswer: text.includes('正确答案') || text.includes('知识点解析'),
      };
    });
    check('渲染选项', beforeSubmit.options > 0, `options=${beforeSubmit.options}`);
    check('提交前不显示正确答案', beforeSubmit.hasResult === 0 && !beforeSubmit.leaksAnswer);

    await page.evaluate(() => {
      document.querySelectorAll<HTMLInputElement>('.option input').forEach((input, i) => {
        if (i % 4 === 0) input.click();
      });
    });
    await clickByText(page, '.btn', '提交答案');
    await waitForText(page, '本次得分', 20000);
    const afterSubmit = await page.evaluate(() => ({
      correct: document.querySelectorAll('.option--correct').length,
      wrong: document.querySelectorAll('.option--wrong').length,
      score: document.querySelector('.banner')?.textContent ?? '',
    }));
    check('提交后标注正确选项', afterSubmit.correct > 0, JSON.stringify(afterSubmit));
    check('提交后显示得分', afterSubmit.score.includes('得分'), afterSubmit.score);
    await page.screenshot({ path: path.join(OUT, '04-mcq-graded.png') });

    console.log('\n▸ 练习模式：原文挖空');
    // 先跳转到进程管理（内容丰富，适合测试挖空）
    // 通过 API 直接设置当前路径，绕过 UI 树交互的脆弱性
    await page.evaluate(async () => {
      // 设置目标路径并清空练习缓存，确保为新文档重新生成
      const settingsKey = 'mdlearn:settings';
      const saved = localStorage.getItem(settingsKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        parsed.state.currentPath = '操作系统/进程管理.md';
        localStorage.setItem(settingsKey, JSON.stringify(parsed));
      }
      localStorage.removeItem('mdlearn:exercises');
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await waitForText(page, '进程管理', 10000);
    await clickByText(page, '.segmented button', '练习');
    await new Promise((r) => setTimeout(r, 300));
    await clickByText(page, '.segmented button', '原文挖空');
    await waitForText(page, '开始生成原文挖空', 15000);
    // Reset mock call counter before this generation
    // 确保"开始生成"按钮可见并可点击后再点击
    await page.waitForSelector('.btn--primary', { timeout: 5000 });
    await clickByText(page, '.btn--primary', '开始生成原文挖空');
    console.log('  [e2e] Clicked cloze generate, waiting...');
    // 等待"重新生成"出现（说明生成流程已经完成）
    await page.waitForFunction(() =>
      document.body.innerText.includes('重新生成') ||
      document.querySelectorAll('.banner--error').length > 0,
      { timeout: 35000 }
    );
    await new Promise((r) => setTimeout(r, 500));
    // 检查实际 DOM 状态
    const afterGen = await page.evaluate(() => ({
      inputs: document.querySelectorAll('.cloze-blank__input').length,
      statics: document.querySelectorAll('.cloze-blank--static').length,
      errors: document.querySelectorAll('.banner--error').length,
      errText: document.querySelector('.banner--error')?.textContent?.slice(0, 80) ?? '',
      mode: document.querySelector('.segmented button[aria-selected=true]')?.textContent ?? '',
      practiceMds: document.querySelectorAll('.practice__col .md').length,
    }));
    console.log('  [e2e] DOM after cloze gen:', JSON.stringify(afterGen));
    check('挖空题生成成功（无错误横幅）', afterGen.errors === 0, afterGen.errText);
    const clozeInputCount = afterGen.inputs;
    await page.screenshot({ path: path.join(OUT, '05-practice-cloze.png') });
    const clozeCount = clozeInputCount;
    check('在原文中渲染挖空输入框', clozeCount >= 1, `inputs=${clozeCount}, statics=${afterGen.statics}, mds=${afterGen.practiceMds}`);
    const contextOk = await page.evaluate(() => {
      const blank = document.querySelector('.cloze-blank');
      const parent = blank?.closest('p, td, li, blockquote');
      return Boolean(parent && (parent.textContent ?? '').length > 4);
    });
    check('挖空位于原文语句中（保持上下文与排版）', contextOk);

    if (clozeCount > 0) {
      await page.evaluate(() => {
        document.querySelectorAll<HTMLInputElement>('.cloze-blank__input').forEach((input, i) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
          setter.call(input, i === 0 ? '进程' : '错误答案');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
      await clickByText(page, '.btn--primary', '提交答案');
      await waitForText(page, '本次得分', 20000);
      const clozeGraded = await page.evaluate(() => ({
        correct: document.querySelectorAll('.cloze-blank--correct').length,
        wrong: document.querySelectorAll('.cloze-blank--wrong').length,
        hasAnswerText: document.querySelectorAll('.cloze-blank__answer').length,
      }));
      check('提交后标注对错并显示正确答案', clozeGraded.wrong > 0 && clozeGraded.hasAnswerText > 0, JSON.stringify(clozeGraded));
      await page.screenshot({ path: path.join(OUT, '06-cloze-graded.png') });
    } else {
      check('提交后标注对错并显示正确答案', false, '跳过（没有挖空输入框）');
    }

    console.log('\n▸ 复习与反馈模式');
    await clickByText(page, '.segmented button', '复习反馈');
    await waitForText(page, '挖空得分', 20000);
    await page.screenshot({ path: path.join(OUT, '07-review.png') });
    const review = await page.evaluate(() => ({
      hasArticle: Boolean(document.querySelector('.page .md')),
      hasFeedback: Boolean(document.querySelector('.feedback__body .card')),
      splitter: Boolean(document.querySelector('.splitter')),
    }));
    check('左侧显示原文、右侧显示反馈', review.hasArticle && review.hasFeedback);
    check('提供宽度调整分隔条', review.splitter);

    await page.click('.feedback__head .icon-btn');
    await new Promise((r) => setTimeout(r, 400));
    const collapsed = await page.evaluate(() => document.querySelector('.feedback')?.className.includes('collapsed'));
    check('反馈区可以折叠', Boolean(collapsed));
    await page.screenshot({ path: path.join(OUT, '08-review-collapsed.png') });

    console.log('\n▸ 学习进度');
    const before0 = await page.$eval('.progress-card__value', (el) => el.textContent ?? '');
    await clickByText(page, '.topbar .btn', '标记完成');
    await page.waitForFunction((b) => document.querySelector('.progress-card__value')?.textContent !== b, { timeout: 8000 }, before0);
    const progress = await page.evaluate(() => ({
      value: document.querySelector('.progress-card__value')?.textContent ?? '',
      sub: document.querySelector('.progress-card__sub')?.textContent ?? '',
    }));
    check('标记完成后进度更新', progress.value !== '0%', `${progress.value} / ${progress.sub}`);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.progress-card__value', { timeout: 10000 });
    const progressAfterReload = await page.$eval('.progress-card__value', (el) => el.textContent ?? '');
    check('刷新后学习进度保留', progressAfterReload === progress.value, `${progress.value} → ${progressAfterReload}`);
    await page.screenshot({ path: path.join(OUT, '09-progress.png') });

    console.log('\n▸ 问答题');
    await clickByText(page, '.segmented button', '练习');
    await clickByText(page, '.segmented button', '问答题');
    await waitForText(page, '开始生成问答题', 15000);
    await clickByText(page, '.btn--primary', '开始生成问答题');
    await page.waitForSelector('.qa-input', { timeout: 30000 });
    await page.type('.qa-input', '因为进程拥有独立的地址空间，而线程共享进程资源。');
    await clickByText(page, '.btn--primary', '提交并获取点评');
    await waitForText(page, '总体评价', 30000);
    const qaFeedback = await page.evaluate(() => ({
      score: document.body.innerText.includes('分（'),
      suggestions: document.body.innerText.includes('改进建议'),
      reference: document.body.innerText.includes('参考答案'),
    }));
    check('问答题点评包含得分、改进建议与参考答案', qaFeedback.score && qaFeedback.suggestions && qaFeedback.reference, JSON.stringify(qaFeedback));
    await page.screenshot({ path: path.join(OUT, '10-qa.png') });

    console.log('\n▸ 响应式布局');
    for (const [name, width, height] of [
      ['11-mobile-reading', 390, 844],
      ['12-tablet-reading', 834, 1112],
    ] as const) {
      const p = await browser.newPage();
      watchPage(p);
      await p.setViewport({ width, height, deviceScaleFactor: 2 });
      await p.goto(base, { waitUntil: 'networkidle2' });
      // 切回阅读模式再检查布局
      await p.evaluate(() => {
        const raw = localStorage.getItem('mdlearn:settings');
        if (raw) {
          const v = JSON.parse(raw);
          v.state.mode = 'read';
          v.state.sidebarCollapsed = true;
          localStorage.setItem('mdlearn:settings', JSON.stringify(v));
        }
      });
      await p.reload({ waitUntil: 'networkidle2' });
      await p.waitForSelector('.page__body .md', { timeout: 15000 });
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
      const overflow = await p.evaluate(() => {
        const doc = document.documentElement;
        const overflowing = [...document.querySelectorAll<HTMLElement>('.md, .page, .card, .practice, .workspace')].filter(
          (el) => el.scrollWidth - el.clientWidth > 4 && getComputedStyle(el).overflowX === 'visible',
        );
        return { docOverflow: doc.scrollWidth > doc.clientWidth + 2, count: overflowing.length };
      });
      check(`${width}px 宽度下无横向溢出`, !overflow.docOverflow && overflow.count === 0, JSON.stringify(overflow));
      await p.close();
    }

    await errorScenarios(browser, clientDir);

    console.log('\n▸ 浏览器控制台');
    check('没有控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await events.close();
    server.close();
    mock.kill();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log(`截图目录：${path.relative(ROOT, OUT)}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
