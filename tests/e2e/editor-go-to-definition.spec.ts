// TS / JS 转到定义(真实 TypeScript 语言服务进程):⌘ / Ctrl 单击与 F12 跳到另一文件、⌃- 退回;node_modules 假包;未保存修改后
// 的位置;⌘ 悬停下划线;popout 子窗里 F12。BDD: src/__tests__/editor-go-to-definition/
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { explorerTreeItem, openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isMac = process.platform === 'darwin';
const MOD = isMac ? 'Meta' : 'Control';
const BACK = isMac ? 'Control+Minus' : 'Alt+ArrowLeft';
const editors = (page: Page) => page.locator('[data-editor-panel-root] .cm-content');

const A_TS = [
  "import { helper } from './lib/b';",
  "import { fake } from 'fakepkg';",
  '',
  'export function main(): number {',
  '  fake();',
  '  return helper();',
  '}',
  '',
].join('\n');
// 两个文件互相 import(b.ts 末尾引回 a.ts)
const B_TS = [
  '// lib',
  '',
  'export function helper(): number {',
  '  return 1;',
  '}',
  '',
  "import { main } from '../a';",
  'export const loop = (): number => main();',
  '',
].join('\n');

function write(ws: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), text);
}

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui158-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui158-ws-'));
  dirs.push(ud, ws);
  write(ws, 'tsconfig.json', '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}');
  write(ws, 'a.ts', A_TS);
  write(ws, 'lib/b.ts', B_TS);
  write(ws, 'node_modules/fakepkg/package.json', '{"name":"fakepkg","types":"index.d.ts"}');
  write(ws, 'node_modules/fakepkg/index.d.ts', '/** fake package */\nexport declare function fake(): void;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await waitForTestHooks(win);
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await openTreeItem(win, /^a\.ts$/);
  await expect(editors(win)).toContainText('return helper();', { timeout: 10_000 });
  return { app, win };
}

/** 编辑器里第一处 needle 中第 offset 个字符的屏幕坐标。 */
async function coordsOf(page: Page, needle: string, offset = 1): Promise<{ x: number; y: number }> {
  const pt = await page.locator('[data-editor-panel-root] .cm-content').first().evaluate(
    (root, [text, at]) => {
      // 高亮把一行拆成多个 span:先找含 needle 的行,再按字符偏移走该行的文本节点
      const line = [...root.querySelectorAll('.cm-line')].find((l) => l.textContent!.includes(text as string));
      if (!line) return null;
      let target = line.textContent!.indexOf(text as string) + (at as number);
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent!.length;
        if (target < len) {
          const range = document.createRange();
          range.setStart(n, target);
          range.setEnd(n, target + 1);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        target -= len;
      }
      return null;
    },
    [needle, offset] as const,
  );
  if (!pt) throw new Error(`text not found: ${needle}`);
  return pt;
}

async function clickAt(page: Page, needle: string, offset = 1, modifiers: ('Meta' | 'Control')[] = []): Promise<void> {
  const { x, y } = await coordsOf(page, needle, offset);
  await page.mouse.move(x, y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
}

test('⌘ 单击 import 的函数 → 打开 lib/b.ts 定位到声明;⌃- 回到 a.ts;F12 跳到 node_modules 假包的 .d.ts', async () => {
  test.setTimeout(120_000);
  const { win } = await launch();
  const started = Date.now();
  await clickAt(win, 'helper();', 2, [MOD]);
  await expect(editors(win)).toContainText('// lib', { timeout: 30_000 });
  await expect(win.locator('.cm-activeLine')).toHaveText('export function helper(): number {');
  console.log(`[ui158] first cross-file jump: ${Date.now() - started}ms`);

  await win.keyboard.press(BACK);
  await expect(editors(win)).toContainText('return helper();');
  await expect(win.locator('.cm-activeLine')).toHaveText('  return helper();');

  await clickAt(win, 'fake();', 1);
  await win.keyboard.press('F12');
  await expect(editors(win)).toContainText('fake package', { timeout: 15_000 });
  await expect(win.locator('.cm-activeLine')).toHaveText('export declare function fake(): void;');
});

test('未保存的修改:b.ts 插入空行不保存,a.ts 里 F12 跳到移动后的行', async () => {
  test.setTimeout(120_000);
  const { win } = await launch();
  await explorerTreeItem(win, /^lib$/).click();
  await openTreeItem(win, /^b\.ts$/);
  await expect(editors(win)).toContainText('// lib', { timeout: 10_000 });
  await clickAt(win, '// lib', 0);
  await win.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < 5; i++) await win.keyboard.press('Enter');
  await openTreeItem(win, /^a\.ts$/);
  await expect(editors(win)).toContainText('return helper();');
  await clickAt(win, 'helper();', 2);
  await win.keyboard.press('F12');
  await expect(editors(win)).toContainText('// lib', { timeout: 30_000 });
  await expect(win.locator('.cm-activeLine')).toHaveText('export function helper(): number {');
  const line = await win.evaluate(() => document.querySelector('.cm-activeLineGutter')?.textContent ?? '');
  expect(line).toBe('8');
});

test('按住 ⌘ 悬停在可跳转的标识符上 → 下划线;松开 → 消失', async () => {
  test.setTimeout(120_000);
  const { win } = await launch();
  await clickAt(win, 'export function main', 0);
  const { x, y } = await coordsOf(win, 'helper();', 2);
  await win.keyboard.down(MOD);
  await win.mouse.move(x - 1, y);
  await win.mouse.move(x, y);
  await expect(win.locator('.cm-definition-link')).toHaveText('helper', { timeout: 30_000 });
  await win.keyboard.up(MOD);
  await expect(win.locator('.cm-definition-link')).toHaveCount(0);
});

test('popout 子窗里 F12 → 在子窗的编辑器组打开定义', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.moveEditorGroupToNewWindow'));
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(editors(child)).toContainText('return helper();', { timeout: 10_000 });
  const cdp = await child.context().newCDPSession(child);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await child.bringToFront();
  await clickAt(child, 'helper();', 2);
  await child.keyboard.press('F12');
  await expect(editors(child)).toContainText('// lib', { timeout: 30_000 });
  await expect(child.locator('.cm-activeLine')).toHaveText('export function helper(): number {');
});
