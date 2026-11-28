// 插件作者视角(BDD: src/__tests__/plugin-dev-experience/、src/__tests__/plugin-output-channel/):真实第三方插件
//(userData/plugins/<id>)经 PluginManager 加载 —— 无效插件行与一次通知、运行中修好即出现;onload 抛错带 sourceURL 位置;
// 语法错误带行号且不执行代码;未声明权限的报错文案;app.output 写入输出面板对应通道;sourceURL 断点跨热重载保留。
// 测试插件只做无害操作(写全局变量 / 输出通道 / 本用例临时目录里的探针文件),不发网络请求。
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { openSettingsTab, PLUGINS_TAB } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';

const GOOD = 'com.e2e.good';
const THROWS = 'com.e2e.throws';
const SYNTAX = 'com.e2e.syntax';
const BAD = 'com.e2e.bad';

let ud = '';
let probe = '';

function writePlugin(id: string, manifest: object | string, main?: string): void {
  const dir = path.join(ud, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (main !== undefined) writeFileSync(path.join(dir, 'main.js'), main);
}

// onload 写输出通道;命令读未声明的 fs 权限。第 4 行(0 起第 3 行)是断点位置。
const GOOD_MAIN = `const { Plugin } = globalThis.co;
export default class Good extends Plugin {
  onload() {
    globalThis.__pdxGoodLoads = (globalThis.__pdxGoodLoads ?? 0) + 1;
    this.app.output.appendLine('hello from good #' + globalThis.__pdxGoodLoads);
    this.addCommand({ id: 'pdx.readfs', title: 'PDX read fs', fn: () => this.app.fs.readFile('/nonexistent') });
  }
}
`;

const THROWS_MAIN = `const { Plugin } = globalThis.co;
function helper() {
  throw new Error('pdx onload boom');
}
export default class Throws extends Plugin {
  onload() {
    helper();
  }
}
`;

function seed(): void {
  writePlugin(GOOD, { id: GOOD, name: 'PDX Good', version: '1.0.0' }, GOOD_MAIN);
  writePlugin(THROWS, { id: THROWS, name: 'PDX Throws', version: '1.0.0' }, THROWS_MAIN);
  // 语法错误在第 3 行;前面的语句若被执行(renderer 或主进程的语法检查)就会留下探针。
  writePlugin(
    SYNTAX,
    { id: SYNTAX, name: 'PDX Syntax', version: '1.0.0' },
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(probe)}, 'ran'); globalThis.__pdxSyntaxRan = true;\nlet = = 1;\n`,
  );
  writePlugin(BAD, { id: BAD, name: 'PDX Bad', version: 'not-semver' }, `export default class extends globalThis.co.Plugin { onload() {} }\n`);
  writeFileSync(path.join(ud, 'plugins', '_enabled.json'), JSON.stringify([GOOD, THROWS, SYNTAX, BAD]));
}

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForTestHooks(win);
  return { app, win };
}

const toastsMatching = (win: Page, re: RegExp) => win.locator('.toast__message').filter({ hasText: re });
const userSection = (win: Page) => win.locator('[data-plugins-section="user"]');

test.beforeEach(() => {
  ud = mkdtempSync(path.join(tmpdir(), 'continuo-pdx-'));
  probe = path.join(ud, 'syntax-probe.txt');
  seed();
});
test.afterEach(() => {
  rmSync(ud, { recursive: true, force: true });
});

test('无效插件:插件页显示无效行与字段级原因、通知一次;运行中修好 manifest 无需重载即出现', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  try {
    await expect(toastsMatching(win, /PDX Bad/)).toHaveCount(1, { timeout: 15_000 });
    await expect(toastsMatching(win, /version/)).toHaveCount(1);
    await openSettingsTab(win, PLUGINS_TAB);
    const row = userSection(win).locator(`[data-plugin-invalid="${BAD}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-code="SCHEMA_ERROR"]')).toContainText('version');
    await expect(row.locator('[data-code="SCHEMA_ERROR"]')).toContainText('1.2.3');

    writeFileSync(path.join(ud, 'plugins', BAD, 'manifest.json'), JSON.stringify({ id: BAD, name: 'PDX Bad', version: '1.0.0' }));
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await expect(userSection(win).getByText('PDX Bad', { exact: true })).toBeVisible();
    // 盘上已启用 → 修好后已激活(行上有「禁用」)
    await expect(userSection(win).getByRole('button', { name: /PDX Bad$/ }).filter({ hasText: /^(禁用|Disable|비활성)$/ })).toBeVisible();
    await expect(toastsMatching(win, /PDX Bad/)).toHaveCount(1); // 仍只通知过一次
  } finally {
    await closeDiscardingUnsaved(app);
  }
});

test('onload 抛错带 sourceURL 位置;语法错误带行号且代码未执行;未声明权限报错指明 manifest.json', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  try {
    await openSettingsTab(win, PLUGINS_TAB);
    const section = userSection(win);
    await expect(section.locator('[data-code="EXCEPTION"]')).toContainText('pdx onload boom', { timeout: 15_000 });
    await expect(section.locator('[data-code="EXCEPTION"]')).toContainText('main.js:3:9');
    const syntax = section.locator('[data-code="IMPORT_SYNTAX_ERROR"]');
    await expect(syntax).toContainText('main.js:3:');
    expect(existsSync(probe)).toBe(false);
    expect(await win.evaluate(() => (globalThis as { __pdxSyntaxRan?: boolean }).__pdxSyntaxRan)).toBeUndefined();

    // 经命令面板执行(贡献回调失败 → 通知,与用户操作同一路径)
    await openCommandPalette(win);
    await commandPaletteInput(win).fill('PDX read fs');
    await win.keyboard.press('Enter');
    await expect(toastsMatching(win, /manifest\.json/)).toHaveCount(1, { timeout: 10_000 });
    await expect(toastsMatching(win, /manifest\.json/)).toContainText('fs');
  } finally {
    await closeDiscardingUnsaved(app);
  }
});

test('app.output.appendLine 出现在输出面板对应通道;sourceURL 断点跨热重载保留', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  try {
    await expect.poll(() => win.evaluate(() => (globalThis as { __pdxGoodLoads?: number }).__pdxGoodLoads)).toBe(1);
    await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.view.output'));
    const picker = win.locator('[data-output-channel-picker]');
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await picker.click();
    await win.getByRole('menuitemradio', { name: 'PDX Good' }).click();
    await expect(win.locator(`[data-output-channel="plugin:${GOOD}"]`)).toContainText('hello from good #1');
    // 宿主把其它插件的失败写进各自通道
    await picker.click();
    await win.getByRole('menuitemradio', { name: 'PDX Throws' }).click();
    await expect(win.locator(`[data-output-channel="plugin:${THROWS}"]`)).toContainText('[error]');
    await expect(win.locator(`[data-output-channel="plugin:${THROWS}"]`)).toContainText('main.js:3:9');

    // DevTools 断点按 sourceURL 记:设在 continuo-plugin://<id>/main.js 第 4 行,改 main.js 触发热重载 → 新代码在同一地址命中。
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Debugger.enable');
    const { breakpointId } = await cdp.send('Debugger.setBreakpointByUrl', {
      url: `continuo-plugin://${GOOD}/main.js`,
      lineNumber: 3,
    });
    const scriptUrls = new Map<string, string>();
    cdp.on('Debugger.scriptParsed', (e: { scriptId: string; url: string }) => scriptUrls.set(e.scriptId, e.url));
    const paused = new Promise<string>((resolve) => {
      cdp.once('Debugger.paused', (e: { hitBreakpoints?: string[]; callFrames: { location: { scriptId: string } }[] }) => {
        const hit = e.hitBreakpoints?.includes(breakpointId) === true;
        resolve(hit ? (scriptUrls.get(e.callFrames[0]?.location.scriptId ?? '') ?? 'unknown-script') : 'other-pause');
      });
    });
    const mainPath = path.join(ud, 'plugins', GOOD, 'main.js');
    writeFileSync(mainPath, readFileSync(mainPath, 'utf8').replace('hello from good', 'hello again from good'));
    const t = Date.now() / 1000 + 5;
    utimesSync(mainPath, t, t);
    const url = await Promise.race([paused, new Promise<string>((r) => setTimeout(() => r('timeout'), 20_000))]);
    expect(url).toBe(`continuo-plugin://${GOOD}/main.js`);
    await cdp.send('Debugger.removeBreakpoint', { breakpointId });
    await cdp.send('Debugger.resume');
    await cdp.send('Debugger.disable');
    await picker.click();
    await win.getByRole('menuitemradio', { name: 'PDX Good' }).click();
    await expect(win.locator(`[data-output-channel="plugin:${GOOD}"]`)).toContainText('hello again from good #2');
    // 跨重载默认通道保留上一轮的输出
    await expect(win.locator(`[data-output-channel="plugin:${GOOD}"]`)).toContainText('hello from good #1');
  } finally {
    await closeDiscardingUnsaved(app);
  }
});

// 第六十八轮 A 组审计:高频写输出时滚轮锁定、激活期权限错误本地化、manifest 非法 JSON 的原因、删除无效目录、长行语法错误位置。
test.describe('插件开发体验(第六十八轮)', () => {
  const SPAM = 'com.e2e.spam';
  const PERM = 'com.e2e.perm';
  const JSONBAD = 'com.e2e.jsonbad';
  const LONG = 'com.e2e.long';

  // 每 2ms 写 20 行(onunload 停止)。
  const SPAM_MAIN = `const { Plugin } = globalThis.co;
export default class Spam extends Plugin {
  onload() {
    let n = 0;
    this.timer = setInterval(() => {
      for (let i = 0; i < 20; i += 1) this.app.output.appendLine('spam line ' + n++);
    }, 2);
  }
  onunload() {
    clearInterval(this.timer);
  }
}
`;
  // onload 里调用未声明的 fs 权限(只读一个不存在的路径;权限门先拒绝,不会真的读)。
  const PERM_MAIN = `const { Plugin } = globalThis.co;
export default class Perm extends Plugin {
  async onload() {
    await this.app.fs.readFile('/nonexistent-pdx');
  }
}
`;

  test.beforeEach(() => {
    writePlugin(SPAM, { id: SPAM, name: 'PDX Spam', version: '1.0.0' }, SPAM_MAIN);
    writePlugin(PERM, { id: PERM, name: 'PDX Perm', version: '1.0.0' }, PERM_MAIN);
    // 非法 JSON + 非默认 main;目录里没有 main.js(旧实现按默认 main.js 报「入口不可用」)
    writePlugin(JSONBAD, `{ "id": "${JSONBAD}", "name": "PDX Json", "version": "1.0.0", "main": "dist/index.js", `);
    // 第 2 行是 20 万字符的长行,语法错误在行尾(位置远超 64 KiB)
    writePlugin(LONG, { id: LONG, name: 'PDX Long', version: '1.0.0' }, `// header\n${'var a = 1;'.repeat(20_000)}let = = 1;\n`);
    writeFileSync(path.join(ud, 'plugins', '_enabled.json'), JSON.stringify([GOOD, THROWS, SYNTAX, BAD, SPAM, PERM, LONG]));
  });

  test('高频写入(每 2ms 20 行)时向上滚轮即锁定自动滚动,滚回底部解锁', async () => {
    test.setTimeout(90_000);
    const { app, win } = await launch();
    try {
      await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.view.output'));
      const picker = win.locator('[data-output-channel-picker]');
      await expect(picker).toBeVisible({ timeout: 15_000 });
      await picker.click();
      await win.getByRole('menuitemradio', { name: 'PDX Spam' }).click();
      const body = win.locator(`[data-output-channel="plugin:${SPAM}"]`);
      await expect(body).toContainText('spam line', { timeout: 10_000 });
      const lock = body.locator('xpath=..').locator('button[aria-pressed]');
      await expect(lock).toHaveAttribute('aria-pressed', 'false');
      await expect
        .poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight * 4))
        .toBe(true);
      const distanceFromBottom = () => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

      await body.hover();
      await win.mouse.wheel(0, -600);
      await expect(lock).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 });
      await win.waitForTimeout(500); // 写入持续进行
      await expect(lock).toHaveAttribute('aria-pressed', 'true');
      expect(await distanceFromBottom()).toBeGreaterThan(100); // 没被拉回底部

      // 向下滚到底 → 解锁,之后跟随到底
      await expect(async () => {
        await win.mouse.wheel(0, 10_000_000);
        await expect(lock).toHaveAttribute('aria-pressed', 'false', { timeout: 500 });
      }).toPass({ timeout: 15_000 });
      await win.waitForTimeout(300);
      expect(await distanceFromBottom()).toBeLessThan(40);
    } finally {
      await closeDiscardingUnsaved(app);
    }
  });

  test('onload 抛的未声明权限错误本地化;非法 JSON 报 manifest 错误;长行语法错误只给行号;删除无效目录行与通道消失', async () => {
    test.setTimeout(90_000);
    const { app, win } = await launch();
    try {
      await openSettingsTab(win, PLUGINS_TAB);
      const section = userSection(win);
      const perm = section.locator('[data-code="PERMISSION_NOT_DECLARED"]');
      await expect(perm).toContainText('manifest.json', { timeout: 15_000 });
      await expect(perm).not.toContainText('is not declared: add'); // 不是 PermissionError 的英文 message 原文

      const json = section.locator(`[data-plugin-invalid="${JSONBAD}"]`);
      await expect(json.locator('[data-code="INVALID_JSON"]')).toBeVisible();
      await expect(json.locator('[data-code="PLUGIN_MAIN_UNAVAILABLE"]')).toHaveCount(0);

      const long = section.locator('[data-code="IMPORT_SYNTAX_ERROR"]').filter({ hasText: /main\.js:2(?!\d)/ });
      await expect(long).toHaveCount(1, { timeout: 15_000 });
      await expect(long).not.toContainText(/main\.js:2:/);

      // 无效插件的默认输出通道在下拉里;删掉目录 → 无效行与通道一并消失
      await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.view.output'));
      const picker = win.locator('[data-output-channel-picker]');
      await expect(picker).toBeVisible({ timeout: 10_000 });
      await picker.click();
      await expect(win.getByRole('menuitemradio', { name: 'PDX Bad' })).toHaveCount(1);
      await win.keyboard.press('Escape');
      rmSync(path.join(ud, 'plugins', BAD), { recursive: true, force: true });
      await openSettingsTab(win, PLUGINS_TAB);
      await expect(section.locator(`[data-plugin-invalid="${BAD}"]`)).toHaveCount(0, { timeout: 15_000 });
      await expect(section.locator(`[data-plugin-invalid="${JSONBAD}"]`)).toBeVisible(); // 其它无效行不受影响
      await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.view.output'));
      await picker.click();
      await expect(win.getByRole('menuitemradio', { name: 'PDX Spam' })).toHaveCount(1);
      await expect(win.getByRole('menuitemradio', { name: 'PDX Bad' })).toHaveCount(0);
    } finally {
      await closeDiscardingUnsaved(app);
    }
  });
});

// 第六十九轮 A 组审计:通道满 10,000 行后锁定滚动,持续写入时视图不再上漂(VSCode 锁定后正在看的内容不动)。
// BDD: src/__tests__/plugin-output-channel/
test.describe('插件开发体验(第六十九轮)', () => {
  const FILL = 'com.e2e.fill';
  // onload 先写满 10,050 行(每 7 行一条会折行的长行),之后每 50ms 写 5 行(头部持续丢行)。
  const FILL_MAIN = `const { Plugin } = globalThis.co;
const line = (n) => 'fill line ' + n + (n % 7 === 3 ? ' ' + 'wrap '.repeat(80) : '');
export default class Fill extends Plugin {
  onload() {
    let n = 0;
    for (; n < 10050; n += 1) this.app.output.appendLine(line(n));
    this.timer = setInterval(() => {
      for (let i = 0; i < 5; i += 1) this.app.output.appendLine(line(n++));
    }, 50);
  }
  onunload() {
    clearInterval(this.timer);
  }
}
`;

  test.beforeEach(() => {
    writePlugin(FILL, { id: FILL, name: 'PDX Fill', version: '1.0.0' }, FILL_MAIN);
    writeFileSync(path.join(ud, 'plugins', '_enabled.json'), JSON.stringify([FILL]));
  });

  test('满 1 万行后锁定滚动:持续写入(头部丢行,含折行长行)时视口顶部的行与位置不变', async () => {
    test.setTimeout(90_000);
    const { app, win } = await launch();
    try {
      await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.view.output'));
      const picker = win.locator('[data-output-channel-picker]');
      await expect(picker).toBeVisible({ timeout: 15_000 });
      await picker.click();
      await win.getByRole('menuitemradio', { name: 'PDX Fill' }).click();
      const body = win.locator(`[data-output-channel="plugin:${FILL}"]`);
      // 通道里最早一行的行号(按文本取,不依赖面板的 DOM 结构)。
      const firstLine = () => body.evaluate((el) => Number(/fill line (\d+)/.exec(el.textContent?.slice(0, 40) ?? '')?.[1] ?? -1));
      await expect.poll(firstLine, { timeout: 15_000 }).toBeGreaterThan(0); // 已满、开始丢头部
      const lock = body.locator('xpath=..').locator('button[aria-pressed]');

      await body.hover();
      await win.mouse.wheel(0, -4000);
      await expect(lock).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 });
      await win.waitForTimeout(800); // 滚轮动画结束
      // 视口顶部那一行的文本与它相对滚动区顶部的位置(caretRangeFromPoint 取命中的字符所在行)。
      const topLine = () =>
        body.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const c = document.caretRangeFromPoint(r.left + 24, r.top + 10);
          if (!c) return null;
          const t = c.startContainer.textContent ?? '';
          const start = t.lastIndexOf('\n', c.startOffset - 1) + 1;
          const end = t.indexOf('\n', start);
          return { text: t.slice(start, end < 0 ? undefined : end).slice(0, 20), offset: Math.round(c.getBoundingClientRect().top - r.top) };
        });
      const before = await topLine();
      expect(before?.text).toMatch(/^fill line \d+/);
      const firstBefore = await firstLine();
      await win.waitForTimeout(2_000);
      expect(await firstLine()).toBeGreaterThan(firstBefore + 50); // 期间头部确实丢了上百行
      expect(await topLine()).toEqual(before);
      await expect(lock).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await closeDiscardingUnsaved(app);
    }
  });
});

// 第七十轮 A 组审计:输出区按行分块渲染后,跨空行选中 / 复制丢了空行(空的块级行不产生换行)。BDD: src/__tests__/plugin-output-channel/
test.describe('插件开发体验(第七十轮)', () => {
  const BLANK = 'com.e2e.blank';
  const BLANK_MAIN = `const { Plugin } = globalThis.co;
export default class Blank extends Plugin {
  onload() {
    this.app.output.appendLine('copy a');
    this.app.output.appendLine('');
    this.app.output.appendLine('');
    this.app.output.appendLine('copy b');
    this.app.output.appendLine('');
    this.app.output.appendLine('copy c');
  }
}
`;

  test.beforeEach(() => {
    writePlugin(BLANK, { id: BLANK, name: 'PDX Blank', version: '1.0.0' }, BLANK_MAIN);
    writeFileSync(path.join(ud, 'plugins', '_enabled.json'), JSON.stringify([BLANK]));
  });

  test('跨空行选中输出:选区文本保留空行(与通道内容的换行一致)', async () => {
    const { app, win } = await launch();
    try {
      await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.view.output'));
      const picker = win.locator('[data-output-channel-picker]');
      await expect(picker).toBeVisible({ timeout: 15_000 });
      await picker.click();
      await win.getByRole('menuitemradio', { name: 'PDX Blank' }).click();
      const body = win.locator(`[data-output-channel="plugin:${BLANK}"]`);
      await expect(body).toContainText('copy c');
      // 从「copy a」开头拖选到「copy c」末尾(真实鼠标选区),读选区文本(不经系统剪贴板)
      const range = await body.evaluate((el) => {
        const lines = [...el.querySelectorAll('[data-line]')];
        const first = lines.find((l) => l.textContent === 'copy a')!.getBoundingClientRect();
        const last = lines.find((l) => l.textContent === 'copy c')!;
        const r = document.createRange();
        r.selectNodeContents(last);
        const end = r.getBoundingClientRect();
        return { x0: first.left + 1, y0: first.top + first.height / 2, x1: end.right - 1, y1: end.top + end.height / 2 };
      });
      await win.mouse.move(range.x0, range.y0);
      await win.mouse.down();
      await win.mouse.move(range.x1, range.y1, { steps: 5 });
      await win.mouse.up();
      const selected = await win.evaluate(() => window.getSelection()?.toString() ?? '');
      expect(selected.replace(/\n+$/, '')).toBe('copy a\n\n\ncopy b\n\ncopy c');
    } finally {
      await closeDiscardingUnsaved(app);
    }
  });
});
