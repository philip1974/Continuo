// 外链确认 + 受信任的域(BDD: src/__tests__/external-link-trusted-domains/)、终端 OSC 8 链接(terminal-url-click)、
// 文件名可见化(file-name-invisible-chars)。
// 绝不真的打开浏览器:main 的 shell.openExternal / openPath 换成只记录的替身,dialog.showMessageBox 换成按序应答的替身。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { EDITOR_MODE_PREVIEW, TERMINAL_INPUT, TERMINAL_PANEL_TAB, editorModeButton, openWorkspaceFile } from './helpers/editor';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

interface Probe {
  opened: string[];
  boxes: { message: string; detail: string; buttons: string[] }[];
}

/** 安装替身;responses = 之后各个对话框依次给的按钮下标(用完后一律「取消」= cancelId)。 */
async function stubShell(app: ElectronApplication, responses: number[] = []): Promise<void> {
  await app.evaluate(({ shell, dialog }, queue) => {
    const g = globalThis as unknown as { __probe: Probe; __responses: number[] };
    g.__probe = { opened: [], boxes: [] };
    g.__responses = queue;
    shell.openExternal = (async (u: string) => {
      g.__probe.opened.push(String(u));
    }) as typeof shell.openExternal;
    shell.openPath = (async (p: string) => {
      g.__probe.opened.push(`openPath:${p}`);
      return '';
    }) as typeof shell.openPath;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args[args.length - 1] as { message: string; detail: string; buttons: string[]; cancelId?: number };
      g.__probe.boxes.push({ message: o.message, detail: o.detail, buttons: o.buttons });
      return { response: g.__responses.shift() ?? o.cancelId ?? 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, responses);
}
const setResponses = (app: ElectronApplication, r: number[]) =>
  app.evaluate((_e, q) => {
    (globalThis as unknown as { __responses: number[] }).__responses = q;
  }, r);
const probe = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __probe: Probe }).__probe);

async function openPreview(window: Page, workspaceRoot: string, name: string, content: string) {
  writeFileSync(path.join(workspaceRoot, name), content);
  await openWorkspaceFile(window, [name]);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  await expect(window.locator('main .milkdown a').first()).toBeVisible({ timeout: 10_000 });
}

test('Markdown 预览:悬停显示真实地址;单击不受信外链先确认(完整地址),取消不打开、打开才打开', async ({
  electronApp,
  window,
  workspaceRoot,
}) => {
  await stubShell(electronApp, [3]);
  const evil = 'https://evil.example/login?next=%2Fhome#x';
  await openPreview(window, workspaceRoot, 'links.md', `[https://good.example](${evil})\n`);
  const link = window.locator('main .milkdown a').first();
  await link.hover();
  // title 挂在 ProseMirror 之外的外层容器上:取链接最近的带 title 的祖先
  await expect.poll(() => link.evaluate((a) => a.closest('[title]')?.getAttribute('title') ?? null)).toBe(evil);

  await link.click();
  await expect.poll(async () => (await probe(electronApp)).boxes.length).toBe(1);
  const box = (await probe(electronApp)).boxes[0]!;
  expect(box.detail).toBe(evil);
  expect(box.message).toMatch(/Continuo/);
  expect(box.buttons).toHaveLength(4);
  expect((await probe(electronApp)).opened).toEqual([]);

  await setResponses(electronApp, [0]);
  await link.click();
  await expect.poll(async () => (await probe(electronApp)).opened).toEqual([evil]);
});

test('配置受信任的域 → 信任域名及其所有子域:写入 trusted-domains.json,之后同域不再询问;设置页列出该项', async ({
  electronApp,
  window,
  workspaceRoot,
  userDataDir,
}) => {
  await stubShell(electronApp, [2, 1]);
  await openPreview(
    window,
    workspaceRoot,
    'trust.md',
    '[a](https://docs.trusted.example/a)\n\n[b](https://www.trusted.example/b)\n\n[repo](https://github.com/philip1974/Continuo/issues)\n',
  );
  const links = window.locator('main .milkdown a');
  await links.nth(0).click();
  await expect.poll(async () => (await probe(electronApp)).opened).toEqual(['https://docs.trusted.example/a']);
  expect(JSON.parse(readFileSync(path.join(userDataDir, 'trusted-domains.json'), 'utf8'))).toEqual({
    version: 1,
    domains: ['*.trusted.example'],
  });
  await links.nth(1).click();
  await links.nth(2).click(); // 默认受信:本应用仓库
  await expect.poll(async () => (await probe(electronApp)).opened).toHaveLength(3);
  expect((await probe(electronApp)).boxes).toHaveLength(2);

  await waitForTestHooks(window);
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.manageTrustedDomain'))).toBe(true);
  const row = window.locator('[data-setting-row="workbench.trustedDomains"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByText('*.trusted.example')).toBeVisible();
  await expect(row.getByText('https://github.com/philip1974/Continuo')).toBeVisible();
});

test('终端 OSC 8 超链接:悬停显示真实地址,普通单击不打开,⌘ / Ctrl+单击经确认后打开', async ({ electronApp, window }) => {
  await stubShell(electronApp, []);
  await waitForTestHooks(window);
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  const text = () => window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');
  await expect.poll(text, { timeout: 15_000 }).not.toBe('');
  const uri = 'https://osc.example/real';
  await window.keyboard.type(`clear; printf '\\033]8;;${uri}\\033\\\\OSCLINKTEXT\\033]8;;\\033\\\\\\n'`);
  await window.keyboard.press('Enter');
  await expect.poll(async () => (await text()).split('\n').some((l) => l === 'OSCLINKTEXT'), { timeout: 10_000 }).toBe(true);
  const row = (await text()).split('\n').indexOf('OSCLINKTEXT');
  const host = window.locator('[data-testid=terminal-panel-view-xterm-host]');
  const screen = (await host.locator('.xterm-screen').boundingBox())!;
  const rows = await window.evaluate(() => {
    const el = document.querySelector('[data-testid=terminal-panel-view-xterm-host] .xterm-rows');
    return el ? el.children.length : 24;
  });
  const lineH = screen.height / rows;
  const at = { x: screen.x + 30, y: screen.y + (row + 0.5) * lineH };
  await window.mouse.move(at.x, at.y + 1);
  await window.mouse.move(at.x, at.y);
  await expect(host).toHaveAttribute('title', new RegExp(`^${uri.replace(/[.]/g, '\\.')}\\n`), { timeout: 5_000 });

  await window.mouse.click(at.x, at.y);
  await window.waitForTimeout(300);
  expect((await probe(electronApp)).boxes).toEqual([]);

  await setResponses(electronApp, [0]);
  await window.keyboard.down(MOD);
  await window.mouse.click(at.x, at.y);
  await window.keyboard.up(MOD);
  await expect.poll(async () => (await probe(electronApp)).opened).toEqual([uri]);
  expect((await probe(electronApp)).boxes.map((b) => b.detail)).toEqual([uri]);
});

test('资源管理器与 tab:文件名里的 RLO 可见化', async ({ window, workspaceRoot }) => {
  const name = 'invoice‮txt.md';
  writeFileSync(path.join(workspaceRoot, name), 'x\n');
  const shown = 'invoice�txt.md';
  const row = window.getByRole('treeitem').filter({ hasText: shown });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(window.getByRole('tab').filter({ hasText: shown }).first()).toBeVisible({ timeout: 10_000 });
});

test('代码编辑器:双向控制字符显示为占位符,混进标识符的西里尔字母加框(BDD: editor-unicode-highlight)', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'trojan.ts'), 'const isAdmin = false; /*‪ } ⁨ if (isAdmin) */\nconst pаssword = 1;\n');
  await openWorkspaceFile(window, ['src', 'trojan.ts']);
  const content = window.locator('main .cm-content');
  await expect(content).toBeVisible({ timeout: 10_000 });
  await expect(content.locator('.cm-specialChar')).toHaveCount(2);
  await expect(content.locator('.cm-ambiguousChar')).toHaveText(['а']);
});
