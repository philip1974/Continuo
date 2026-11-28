// 高对比度主题细节(BDD: src/__tests__/high-contrast-theme/ README「4. HC 专有边框」):
//   1. 对话框 / 工具栏里的 ghost 次要按钮画 contrastBorder(保存冲突确认框、冲突比较工具栏、授权弹窗);Welcome 列表项不画
//   2. Markdown 内嵌代码块:编辑时只有获焦的代码块画当前行框,预览不画;普通代码编辑器失焦仍画
//   3. Markdown 分隔线前景色、引用只一条前景色竖条
//   4. dock tab 键盘焦点 2px、无内层重复轮廓
//   5. 光标在调试执行行上:执行行淡底仍在
// 截图放 HC_SHOTS_DIR(未设置则不截)。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = path.join(REPO, 'scripts/debug-spike/.adapter/js-debug/src/dapDebugServer.js');
const SHOTS = process.env['HC_SHOTS_DIR'];
const COMPARE = /^(比较|Compare|비교)$/;
const REVERT = /^(使用磁盘版本（放弃我的更改）|Use Disk Version \(Discard My Changes\)|디스크 버전 사용\(내 변경 내용 취소\))$/;
const GRANT_SESSION = /^(本次启动期间允许|Allow this launch|이번 실행 동안 허용)$/;
const DENY = /^(拒绝|Deny|거부)$/;
// HC 深:contrastBorder #6FC3DF、前景白、focusBorder #F38518
const CONTRAST_BORDER = 'rgb(111, 195, 223)';
const FG = 'rgb(255, 255, 255)';
const FOCUS = 'rgb(243, 133, 24)';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const procs: ChildProcessWithoutNullStreams[] = [];
test.afterEach(async () => {
  for (const p of procs.splice(0)) p.kill();
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(kind: string): string {
  const dir = mkdtempSync(path.join(process.env['CONTINUO_E2E_TMPDIR'] ?? tmpdir(), `hc-${kind}-`));
  dirs.push(dir);
  return dir;
}

async function launchHc(files: Record<string, string>): Promise<{ app: ElectronApplication; win: Page; ud: string; ws: string }> {
  const ud = tempDir('ud');
  const ws = tempDir('ws');
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(ws, name), text);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForAppReady(win);
  await waitForTestHooks(win);
  await win.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.theme', 'hcDark'));
  await expect.poll(() => win.evaluate(() => document.documentElement.classList.contains('hc-black'))).toBe(true);
  return { app, win, ud, ws };
}

const css = (el: Locator, prop: string, pseudo?: string): Promise<string> =>
  el.evaluate((n, [p, ps]) => getComputedStyle(n, ps ?? null).getPropertyValue(p!), [prop, pseudo] as const);

async function shot(target: Page | Locator, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const MD = [
  '# T',
  '',
  '```ts',
  'const a = 1;',
  'const b = 2;',
  '```',
  '',
  '---',
  '',
  '> quoted',
  '',
  '```ts',
  'const c = 3;',
  '```',
  '',
].join('\n');

test('HC:Welcome 列表项无边框;保存冲突确认框 / 冲突比较工具栏的 ghost 按钮画 contrastBorder;dock tab 键盘焦点 2px 单层', async () => {
  test.setTimeout(90_000);
  const { win, ws } = await launchHc({ 'a.ts': 'export const a = 1;\n' });
  const welcome = win.locator('[data-welcome-action]').first();
  await expect(welcome).toBeVisible({ timeout: 10_000 });
  expect(await css(welcome, 'border-top-color')).toBe('rgba(0, 0, 0, 0)');

  await openTreeItem(win, /^a\.ts$/);
  const cm = win.locator('.cm-content').first();
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await cm.click();
  await win.keyboard.press('ControlOrMeta+End');
  await win.keyboard.type('// mine\n');
  await expect(win.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });
  writeFileSync(path.join(ws, 'a.ts'), 'export const theirs = 1;\n');
  await win.keyboard.press('ControlOrMeta+s');
  const dialog = win.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const ghosts = dialog.locator('.wm-button[data-variant="ghost"]');
  expect(await ghosts.count()).toBeGreaterThan(0);
  for (const b of await ghosts.all()) expect(await css(b, 'border-top-color')).toBe(CONTRAST_BORDER);
  await shot(dialog, 'hc-conflict-dialog');
  await dialog.getByRole('button', { name: COMPARE }).click();
  const panel = win.locator('[data-conflict-diff-panel]');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  expect(await css(panel.getByRole('button', { name: REVERT }), 'border-top-color')).toBe(CONTRAST_BORDER);
  await shot(panel.getByRole('toolbar'), 'hc-conflict-toolbar');

  // dock tab 键盘焦点:编辑器组 + 冲突比较两个 tab,焦点放到 tab 上再方向键移到另一个(键盘 → focus-visible)
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const tabs = win.locator('.dv-tab [role="tab"][tabindex="0"]');
  await tabs.first().focus();
  await win.keyboard.press('ArrowRight');
  const focused = win.locator('.dv-tab:has(:focus-visible)');
  await expect(focused).toHaveCount(1);
  expect(await css(focused, 'outline-width', '::after')).toBe('2px');
  expect(await css(focused, 'outline-color', '::after')).toBe(FOCUS);
  expect(await css(focused.locator('[role="tab"]'), 'outline-style')).toBe('none');
  await shot(win.locator('.dv-tabs-and-actions-container').first(), 'hc-docktab-focus');
});

test('HC:Markdown 代码块当前行只在获焦的可编辑代码块画;分隔线 / 引用竖条前景色;普通编辑器失焦仍画当前行', async () => {
  test.setTimeout(90_000);
  const { win } = await launchHc({ 'n.md': MD, 'a.ts': 'const x = 1;\nconst y = 2;\n' });
  await openTreeItem(win, /^a\.ts$/);
  await win.locator('.cm-content').first().click();
  await openTreeItem(win, /^n\.md$/);
  await win.locator('.wm-segmented-option').filter({ hasText: EDITOR_MODE_EDIT }).first().click();
  const md = win.locator('.milkdown');
  await expect(md.locator('.cm-editor')).toHaveCount(2, { timeout: 15_000 });
  const blockLines = md.locator('.cm-editor .cm-activeLine');

  // 未获焦:任何代码块都不画当前行框
  await md.locator('.ProseMirror h1').click();
  for (const l of await blockLines.all()) expect(await css(l, 'outline-style')).toBe('none');
  // 分隔线 / 引用
  const hr = md.locator('.ProseMirror hr');
  expect(await css(hr, 'background-color')).toBe(FG);
  const quote = md.locator('.ProseMirror blockquote');
  expect(await css(quote, 'background-color', '::before')).toBe(FG);
  expect(await css(quote, 'border-left-width')).toBe('0px');
  await shot(md, 'hc-md-edit-unfocused');

  // 点进第 2 个代码块:只有它画
  await md.locator('.cm-editor').nth(1).locator('.cm-line').first().click();
  await expect.poll(() => css(md.locator('.cm-editor').nth(1).locator('.cm-activeLine'), 'outline-style')).toBe('solid');
  expect(await css(md.locator('.cm-editor').nth(0).locator('.cm-activeLine'), 'outline-style')).toBe('none');
  await shot(md, 'hc-md-edit-focused');

  // 预览:点进代码块也不画
  await win.locator('.wm-segmented-option').filter({ hasText: EDITOR_MODE_PREVIEW }).first().click();
  await expect(win.locator('.milkdown .ProseMirror[contenteditable="false"]')).toBeVisible({ timeout: 10_000 });
  await win.locator('.milkdown .cm-editor').first().locator('.cm-line').first().click();
  for (const l of await win.locator('.milkdown .cm-editor .cm-activeLine').all()) expect(await css(l, 'outline-style')).toBe('none');
  await shot(win.locator('.milkdown'), 'hc-md-preview');

  // 普通代码编辑器(失焦)仍画当前行
  await win.locator('.dv-tab [role="tab"]').first().click();
  await win.getByRole('tab', { name: /^a\.ts/ }).first().click();
  const codeLine = win.locator('.cm-editor:not(.milkdown .cm-editor) .cm-activeLine').first();
  await expect(codeLine).toBeVisible({ timeout: 10_000 });
  await win.locator('[role="treeitem"]').first().focus();
  await expect.poll(() => css(codeLine, 'outline-style')).toBe('solid');
});

/** 最小 MCP 客户端(同 color-vision-cues.spec.ts):经 scripts/continuo-mcp-stdio.mjs 连本实例 <userData>/mcp.sock。 */
function mcpClient(socket: string) {
  const proc = spawn(process.execPath, [path.join(REPO, 'scripts/continuo-mcp-stdio.mjs')], {
    env: { ...process.env, CONTINUO_MCP_SOCKET: socket, CONTINUO_WINDOW_ID: '', CONTINUO_MCP_TOKEN: '' },
  });
  procs.push(proc);
  let buf = '';
  let id = 0;
  const waiters = new Map<number, (msg: { result?: { content?: Array<{ text: string }>; isError?: boolean } }) => void>();
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg as never);
      } catch {
        // 非 JSON 行忽略
      }
    }
  });
  const rpc = (method: string, params: unknown) => {
    const n = ++id;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    return new Promise<{ result?: { content?: Array<{ text: string }>; isError?: boolean } }>((r) => waiters.set(n, r));
  };
  return {
    async init() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const msg = await rpc('tools/call', { name, arguments: args });
      const text = msg.result?.content?.[0]?.text ?? '';
      if (msg.result?.isError) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text) as T;
    },
  };
}

test('HC:授权弹窗「拒绝」画 contrastBorder;光标在调试执行行上时执行行淡底仍在', async () => {
  test.skip(!existsSync(ADAPTER), 'js-debug adapter not fetched (node scripts/fetch-debug-adapter.mjs)');
  test.setTimeout(120_000);
  const { win, ud, ws } = await launchHc({ 'app.js': 'function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nadd(2, 3);\n' });
  await openTreeItem(win, /^app\.js$/);
  const line2 = win.locator('.cm-line').nth(1);
  await expect(line2).toHaveText('  const sum = a + b;', { timeout: 10_000 });
  const gutter = (await win.locator('.cm-breakpoint-gutter').first().boundingBox())!;
  const box = (await line2.boundingBox())!;
  await win.mouse.click(gutter.x + gutter.width / 2, box.y + box.height / 2);
  await expect(win.locator('.cm-debug-breakpoint-marker')).toHaveCount(1);

  const mcp = mcpClient(path.join(ud, 'mcp.sock'));
  await mcp.init();
  const launched = mcp.call<{ session_id: string }>('debug.launch', { program: path.join(ws, 'app.js') });
  const grant = win.getByRole('button', { name: GRANT_SESSION });
  await expect(grant).toBeVisible({ timeout: 15_000 });
  const modal = win.locator('.wm-modal-content');
  expect(await css(modal.getByRole('button', { name: DENY }), 'border-top-color')).toBe(CONTRAST_BORDER);
  await shot(modal, 'hc-auth');
  await win.waitForTimeout(600); // 授权按钮防误触延迟
  await grant.click();
  const { session_id } = await launched;
  await mcp.call('debug.wait_for_stop', { session_id, timeout_ms: 30_000 });
  const exec = win.locator('.cm-line.cm-debug-exec-line');
  await expect(exec).toHaveCount(1, { timeout: 15_000 });
  const execBg = await win.evaluate(() => {
    const el = document.createElement('div');
    el.style.backgroundColor = 'var(--md-debug-exec-line)';
    document.body.append(el);
    const v = getComputedStyle(el).backgroundColor;
    el.remove();
    return v;
  });
  // 光标放到执行行上
  await exec.click();
  await expect(win.locator('.cm-line.cm-debug-exec-line.cm-activeLine')).toHaveCount(1);
  expect(await css(exec, 'background-color')).toBe(execBg);
  expect(execBg).not.toBe('rgba(0, 0, 0, 0)');
  await shot(win.locator('.cm-editor').first(), 'hc-exec-line-cursor');
});
