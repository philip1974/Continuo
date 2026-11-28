// 色觉差异 / 强制颜色(Windows 高对比度)下的非颜色线索,真实 Electron + emulateMedia({ forcedColors: 'active' }):
// 断点红点 / 执行箭头 / 执行行、出现处 / 匹配括号、冲突比较「−」/「+」指示符、toast 等级图标、调试控制台 stderr 竖条、
// 调用栈打不开的帧(非按钮、斜体、不叠透明度)、授权弹窗风险说明。BDD: src/__tests__/color-vision-cues/
// 设 E2E_SHOTS_DIR 时顺带截图(正常 / 强制颜色 / 色觉模拟),供人工核对。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { openTreeItem } from './helpers/explorer';
import { EDITOR_UNSAVED_CHANGES_SELECTOR, openWorkspaceFile } from './helpers/editor';
import { capturePixels, colorDistance, parseRgb } from './helpers/pixels';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = path.join(REPO, 'scripts/debug-spike/.adapter/js-debug/src/dapDebugServer.js');
const GRANT_SESSION = /^(本次启动期间允许|Allow this launch|이번 실행 동안 허용)$/;
const DEBUG_CONSOLE_TAB = /^(调试控制台|Debug Console|디버그 콘솔)$/;
const COMPARE = /^(比较|Compare|비교)$/;

async function shot(target: Page | Locator, name: string): Promise<void> {
  const dir = process.env['E2E_SHOTS_DIR'];
  if (dir) await target.screenshot({ path: path.join(dir, `${name}.png`) });
}

/** 系统色在当前(强制颜色)模式下的实际值。 */
const systemColor = (win: Page, name: string) =>
  win.evaluate((c) => {
    const el = document.createElement('div');
    el.style.cssText = `forced-color-adjust:none;background-color:${c}`;
    document.body.append(el);
    const v = getComputedStyle(el).backgroundColor;
    el.remove();
    return v;
  }, name);

const style = (el: Locator, pseudo?: string) =>
  el.evaluate((n, p) => {
    const s = getComputedStyle(n, p ?? null);
    return {
      bg: s.backgroundColor,
      color: s.color,
      outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
      borderLeft: `${s.borderLeftStyle} ${s.borderLeftWidth} ${s.borderLeftColor}`,
      mask: s.maskImage,
      opacity: s.opacity,
      fontStyle: s.fontStyle,
      fontSize: s.fontSize,
    };
  }, pseudo);

const CV_TS = ['function add(a: number, b: number) {', '  const sum = a + b;', '  return sum;', '}', 'add(1, 2);', ''].join('\n');

test('强制颜色:断点红点、出现处(点线)与匹配括号(实线)、缩进参考线仍可见', async ({ electronApp, window, workspaceRoot }) => {
  await writeFile(path.join(workspaceRoot, 'src/cv.ts'), CV_TS);
  await openWorkspaceFile(window, ['src', 'cv.ts']);
  const line = (n: number) => window.locator('.cm-line').nth(n);
  await expect(line(1)).toHaveText('  const sum = a + b;');
  const gutter = (await window.locator('.cm-breakpoint-gutter').first().boundingBox())!;
  const l2 = (await line(1).boundingBox())!;
  await window.mouse.click(gutter.x + gutter.width / 2, l2.y + l2.height / 2);
  await expect(window.locator('.cm-debug-breakpoint-marker')).toHaveCount(1);
  // 光标放进第 3 行的 sum:其它出现处(第 2 行的 sum)高亮;之后再把光标放到第 1 行行尾「{」后:匹配括号
  await line(2).click();
  await window.keyboard.press('End');
  await window.keyboard.press('ArrowLeft');
  await window.keyboard.press('ArrowLeft');
  await expect(window.locator('.cm-selectionMatch').first()).toBeVisible();
  await shot(window.locator('.cm-editor').first(), 'editor-normal');

  await window.emulateMedia({ forcedColors: 'active' });
  const canvasText = await systemColor(window, 'CanvasText');
  expect((await style(window.locator('.cm-debug-breakpoint-marker'))).bg).toBe(canvasText);
  expect((await style(window.locator('.cm-selectionMatch').first())).outline).toMatch(/^dotted 1px /);
  await shot(window.locator('.cm-editor').first(), 'editor-forced-selection-match');

  await window.keyboard.press('ControlOrMeta+Home');
  await window.keyboard.press('End');
  await expect(window.locator('.cm-matchingBracket').first()).toBeVisible();
  expect((await style(window.locator('.cm-matchingBracket').first())).outline).toMatch(/^solid 1px /);
  // 缩进参考线:当前块那一条 CanvasText(行元素上的自定义属性)
  const marker = window.locator('.cm-indent-markers').first();
  expect(await marker.evaluate((n) => getComputedStyle(n).getPropertyValue('--indent-marker-active-bg-color').trim())).toBe(
    'CanvasText',
  );
  // 像素:第 2–3 行缩进区里参考线是连续竖线(不是只在行间露出的小点 —— 强制颜色的文字底板会盖住 z-index:-1 的 ::before)
  const canvas = parseRgb(await systemColor(window, 'Canvas'));
  const textLeft = await line(1).evaluate((n) => {
    const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !/\S/.test(text.textContent ?? '')) text = walker.nextNode();
    const at = text!.textContent!.search(/\S/);
    const r = document.createRange();
    r.setStart(text!, at);
    r.setEnd(text!, at + 1);
    return r.getBoundingClientRect().left;
  });
  const [b2, b3] = [(await line(1).boundingBox())!, (await line(2).boundingBox())!];
  const clip = { x: b2.x, y: Math.ceil(b2.y), width: Math.floor(textLeft - b2.x) - 1, height: Math.floor(b3.y + b3.height - Math.ceil(b2.y)) };
  const px = await capturePixels(electronApp, window, clip);
  let rows = 0;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (colorDistance(px.at(x, y), canvas) > 48) {
        rows++;
        break;
      }
    }
  }
  expect(rows / px.height).toBeGreaterThan(0.9);
  await shot(window.locator('.cm-editor').first(), 'editor-forced-bracket');
});

test('冲突比较:并排与内联都画「−」/「+」指示符,强制颜色下仍为 CanvasText 字形', async ({
  electronApp,
  window,
  workspaceRoot,
}) => {
  const file = path.join(workspaceRoot, 'src/a.ts');
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const cm = window.locator('.cm-content').first();
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('// mine\n');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });
  await writeFile(file, 'export const theirs = 1;\n');
  await window.keyboard.press('ControlOrMeta+s');
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: COMPARE }).click();
  const panel = window.locator('[data-conflict-diff-panel]');
  await expect(panel).toBeVisible({ timeout: 10_000 });

  const minus = panel.locator('.cm-merge-a .cm-changeGutter .cm-changedLineGutter').first();
  const plus = panel.locator('.cm-merge-b .cm-changeGutter .cm-changedLineGutter').first();
  await expect(minus).toBeVisible();
  await expect(plus).toBeVisible();
  const [m, p] = [await style(minus, '::before'), await style(plus, '::before')];
  expect(m.mask).toMatch(/^url\("data:image\/svg\+xml/);
  expect(p.mask).toMatch(/^url\("data:image\/svg\+xml/);
  expect(m.mask).not.toBe(p.mask);
  expect((await minus.boundingBox())!.width).toBeGreaterThanOrEqual(10);
  await shot(panel, 'conflict-split-normal');

  await window.emulateMedia({ forcedColors: 'active' });
  const canvasText = await systemColor(window, 'CanvasText');
  expect((await style(minus, '::before')).bg).toBe(canvasText);
  expect((await style(plus, '::before')).bg).toBe(canvasText);
  await shot(panel, 'conflict-split-forced');

  // 内联(窄窗口):磁盘版本的只读块 gutter 也有「−」
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 900));
  const deleted = panel.locator('.cm-changeGutter .cm-deletedLineGutter').first();
  await expect(deleted).toBeVisible({ timeout: 10_000 });
  expect((await style(deleted, '::before')).mask).toBe(m.mask);
  expect((await style(deleted, '::before')).bg).toBe(canvasText);
  await shot(panel, 'conflict-inline-forced');
  await window.emulateMedia({ forcedColors: 'none' });
  await shot(panel, 'conflict-inline-normal');
});

test('toast:等级图标是 SVG 字形,强制颜色下按 CanvasText 画出(不是被抹掉的实心圆点)', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'bin.dat'), Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 0x80, 0x81]));
  await openTreeItem(window, 'bin.dat');
  const toast = window.locator('.toast[data-level="error"]').first();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  const icon = toast.locator('.toast__icon svg');
  await expect(icon).toBeVisible();
  await shot(toast, 'toast-error-normal');
  await window.emulateMedia({ forcedColors: 'active' });
  const canvasText = await systemColor(window, 'CanvasText');
  expect(await icon.evaluate((n) => getComputedStyle(n).stroke)).toBe(canvasText);
  await shot(toast, 'toast-error-forced');
  const cdp = await window.context().newCDPSession(window);
  await window.emulateMedia({ forcedColors: 'none' });
  for (const type of ['deuteranopia', 'protanopia', 'achromatopsia'] as const) {
    await cdp.send('Emulation.setEmulatedVisionDeficiency', { type });
    await shot(toast, `toast-error-${type}`);
  }
  await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
});

/** 最小 MCP 客户端:经 scripts/continuo-mcp-stdio.mjs 连本实例的 <userData>/mcp.sock(不发 hello → 主窗)。 */
class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private id = 0;
  private readonly waiters = new Map<number, (msg: { result?: { content?: Array<{ text: string }>; isError?: boolean } }) => void>();

  constructor(socket: string) {
    this.proc = spawn(process.execPath, [path.join(REPO, 'scripts/continuo-mcp-stdio.mjs')], {
      env: { ...process.env, CONTINUO_MCP_SOCKET: socket, CONTINUO_WINDOW_ID: '', CONTINUO_MCP_TOKEN: '' },
    });
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === 'number') this.waiters.get(msg.id)?.(msg as never);
        } catch {
          // 非 JSON 行忽略
        }
      }
    });
  }

  private rpc(method: string, params: unknown): Promise<{ result?: { content?: Array<{ text: string }>; isError?: boolean } }> {
    const id = ++this.id;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }

  async init(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const msg = await this.rpc('tools/call', { name, arguments: args });
    const text = msg.result?.content?.[0]?.text ?? '';
    if (msg.result?.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text) as T;
  }

  close(): void {
    this.proc.kill();
  }
}

const PROGRAM = [
  'function add(a, b) {',
  '  const sum = a + b;',
  '  return sum;',
  '}',
  "console.error('oops');",
  "console.log('before');",
  'add(2, 3);',
  '',
].join('\n');

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const clients: McpClient[] = [];
test.afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('调试:强制颜色下执行箭头 / 箭头里的红点 / 执行行轮廓;控制台 stderr 竖条;调用栈弱化帧;授权风险说明', async () => {
  test.skip(!existsSync(ADAPTER), 'js-debug adapter not fetched (node scripts/fetch-debug-adapter.mjs)');
  test.setTimeout(120_000);
  const base = process.env['CONTINUO_E2E_TMPDIR'] ?? tmpdir();
  const ud = mkdtempSync(path.join(base, 'cv-ud-'));
  const ws = mkdtempSync(path.join(base, 'cv-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'app.js'), PROGRAM);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });

  await openTreeItem(win, 'app.js');
  const line2 = win.locator('.cm-line').nth(1);
  await expect(line2).toHaveText('  const sum = a + b;');
  const gutter = (await win.locator('.cm-breakpoint-gutter').first().boundingBox())!;
  const box = (await line2.boundingBox())!;
  await win.mouse.click(gutter.x + gutter.width / 2, box.y + box.height / 2);
  await expect(win.locator('.cm-debug-breakpoint-marker')).toHaveCount(1);

  const mcp = new McpClient(path.join(ud, 'mcp.sock'));
  clients.push(mcp);
  await mcp.init();
  const launched = mcp.call<{ session_id: string }>('debug.launch', { program: path.join(ws, 'app.js') });
  const grant = win.getByRole('button', { name: GRANT_SESSION });
  await expect(grant).toBeVisible({ timeout: 15_000 });
  // 授权弹窗风险说明:12px、正文色(不是最淡的 fg-dim)、带警告图标
  const note = win.locator('[data-auth-risk-note]');
  await expect(note.locator('svg')).toBeVisible();
  const ns = await style(note);
  expect(ns.fontSize).toBe('12px');
  await shot(win.locator('.wm-modal-content'), 'auth-risk-note');
  await win.waitForTimeout(600); // 授权按钮防误触延迟
  await grant.click();
  const { session_id } = await launched;
  expect((await mcp.call<{ reason: string }>('debug.wait_for_stop', { session_id, timeout_ms: 30_000 })).reason).toBe(
    'breakpoint',
  );
  const exec = win.locator('.cm-debug-exec-marker.cm-debug-exec-on-breakpoint');
  await expect(exec).toHaveCount(1, { timeout: 15_000 });
  const editor = win.locator('.cm-editor').first();
  await shot(editor, 'debug-editor-normal');
  for (const type of ['protanopia', 'deuteranopia'] as const) {
    await cdp.send('Emulation.setEmulatedVisionDeficiency', { type });
    await shot(editor, `debug-editor-${type}`);
  }
  await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });

  await win.emulateMedia({ forcedColors: 'active' });
  const [highlight, highlightText] = [await systemColor(win, 'Highlight'), await systemColor(win, 'HighlightText')];
  expect((await style(exec)).bg).toBe(highlight);
  expect((await style(exec, '::after')).bg).toBe(highlightText);
  expect((await style(win.locator('.cm-line.cm-debug-exec-line'))).outline).toBe(`solid 1px ${highlight}`);
  await shot(editor, 'debug-editor-forced');

  // 调用栈:打不开的帧(node 内部)不是按钮、斜体、不叠透明度
  const deemph = win.locator('[data-deemphasized]').first();
  await expect(deemph).toBeVisible({ timeout: 10_000 });
  const ds = await style(deemph);
  expect(ds.fontStyle).toBe('italic');
  expect(await deemph.evaluate((n) => n.closest('button'))).toBeNull();
  expect(await deemph.evaluate((n) => getComputedStyle(n.closest('.wm-card')!).opacity)).toBe('1');
  await win.emulateMedia({ forcedColors: 'none' });
  await shot(deemph.locator('xpath=ancestor::*[contains(@class,"flex-col")][1]'), 'debug-callstack-normal');

  // 控制台:stderr 行左侧实线竖条,强制颜色下仍画出(CanvasText)
  await win.getByRole('tab', { name: DEBUG_CONSOLE_TAB }).click();
  const err = win.getByRole('log').locator('[data-category="stderr"]').filter({ hasText: 'oops' });
  await expect(err).toHaveCount(1, { timeout: 15_000 });
  expect((await style(err)).borderLeft).toMatch(/^solid 2px /);
  await shot(win.getByRole('log'), 'debug-console-normal');
  await win.emulateMedia({ forcedColors: 'active' });
  const canvasText = await systemColor(win, 'CanvasText');
  expect((await style(err)).borderLeft).toBe(`solid 2px ${canvasText}`);
  const out = win.getByRole('log').locator('[data-category="stdout"]').first();
  await expect(out).toContainText('before');
  expect((await style(out)).borderLeft).not.toContain(canvasText);
  await shot(win.getByRole('log'), 'debug-console-forced');
  await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
  await win.emulateMedia({ forcedColors: 'none' });
  await shot(win.getByRole('log'), 'debug-console-achromatopsia');
  await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
});
