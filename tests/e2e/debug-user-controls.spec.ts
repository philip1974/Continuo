// 用户接管 agent 的调试会话(真实 js-debug):gutter 设断点 → agent 经 MCP debug.launch → 停下时自动打开调试视图并定位
//(焦点留在资源管理器)→ F10 单步 → F5 继续 → 调试控制台 / debug.read_output 看到 console.log → ⇧F5 停止。
// BDD: src/__tests__/debug-user-controls/
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { explorerTreeItem, openTreeItem } from './helpers/explorer';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = path.join(REPO, 'scripts/debug-spike/.adapter/js-debug/src/dapDebugServer.js');
const GRANT_SESSION = /^(本次启动期间允许|Allow this launch|이번 실행 동안 허용)$/;
const DEBUG_CONSOLE_TAB = /^(调试控制台|Debug Console|디버그 콘솔)$/;

const PROGRAM = [
  'function add(a, b) {',
  '  const sum = a + b;',
  '  return sum;',
  '}',
  "console.log('before', 1);",
  'add(2, 3);',
  'add(4, 5);',
  "console.log('after');",
  '',
].join('\n');

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

  rpc(method: string, params: unknown): Promise<{ result?: { content?: Array<{ text: string }>; isError?: boolean } }> {
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

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const clients: McpClient[] = [];

test.afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const execLineText = (win: Page) => win.locator('.cm-debug-exec-line').first().textContent();
const activeRole = (win: Page) =>
  win.evaluate(() => {
    const el = document.activeElement;
    return `${el?.getAttribute('role') ?? el?.tagName}:${el?.textContent?.trim() ?? ''}`;
  });

test('gutter 断点 + agent 启动 → 停下自动定位(不抢焦点)→ F10 / F5 → 控制台输出 → ⇧F5 停止', async () => {
  test.skip(!existsSync(ADAPTER), 'js-debug adapter not fetched (node scripts/fetch-debug-adapter.mjs)');
  test.setTimeout(120_000);
  const base = process.env.CONTINUO_E2E_TMPDIR ?? tmpdir();
  const ud = mkdtempSync(path.join(base, 'dbg-ud-'));
  const ws = mkdtempSync(path.join(base, 'dbg-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'app.js'), PROGRAM);
  writeFileSync(path.join(ws, 'notes.txt'), 'notes\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });

  // 1. 打开 app.js,点第 2 行左侧的断点 gutter → 红点(无会话:用户断点)
  await openTreeItem(win, 'app.js');
  const line2 = win.locator('.cm-line').nth(1);
  await expect(line2).toHaveText('  const sum = a + b;');
  const gutter = await win.locator('.cm-breakpoint-gutter').first().boundingBox();
  const lineBox = await line2.boundingBox();
  await win.mouse.click(gutter!.x + gutter!.width / 2, lineBox!.y + lineBox!.height / 2);
  await expect(win.locator('.cm-debug-breakpoint-marker')).toHaveCount(1);

  // 2. agent 启动会话(首次调用经授权弹窗)
  const mcp = new McpClient(path.join(ud, 'mcp.sock'));
  clients.push(mcp);
  await mcp.init();
  const launched = mcp.call<{ session_id: string }>('debug.launch', { program: path.join(ws, 'app.js') });
  const grant = win.getByRole('button', { name: GRANT_SESSION });
  await expect(grant).toBeVisible({ timeout: 15_000 });
  await win.waitForTimeout(600); // 授权按钮防误触延迟
  await grant.click();
  const { session_id } = await launched;

  // 3. 用户在资源管理器里(单击 notes.txt:预览打开,焦点留在树里);agent 让程序跑起来
  await explorerTreeItem(win, 'notes.txt').click();
  await expect.poll(() => activeRole(win)).toMatch(/^treeitem:.*notes\.txt/);
  const stop1 = mcp.call<{ reason: string }>('debug.wait_for_stop', { session_id, timeout_ms: 30_000 });
  expect((await stop1).reason).toBe('breakpoint');

  // 停下:调试视图自动出现,app.js 定位到第 2 行(执行行),焦点仍在资源管理器
  await expect(win.locator('.cm-debug-exec-line')).toHaveCount(1, { timeout: 15_000 });
  expect(await execLineText(win)).toBe('  const sum = a + b;');
  await expect(win.getByRole('tab', { name: DEBUG_CONSOLE_TAB })).toBeVisible();
  expect(await activeRole(win)).toMatch(/^treeitem:.*notes\.txt/);

  // 4. F10 单步跳过 → 第 3 行;F5 继续 → 第二次调用再停在第 2 行
  await win.keyboard.press('F10');
  await expect.poll(() => execLineText(win), { timeout: 15_000 }).toBe('  return sum;');
  await win.keyboard.press('F5');
  await expect.poll(() => execLineText(win), { timeout: 15_000 }).toBe('  const sum = a + b;');

  // 5. 控制台与 debug.read_output 都看到 console.log
  await win.getByRole('tab', { name: DEBUG_CONSOLE_TAB }).click();
  await expect(win.getByRole('log')).toContainText('before 1', { timeout: 15_000 });
  const out = await mcp.call<{ entries: Array<{ output: string }> }>('debug.read_output', { session_id });
  expect(out.entries.map((e) => e.output).join('')).toContain('before 1');

  // 6. ⇧F5 停止 → 会话结束,执行行清掉,'after' 从未打印
  await win.keyboard.press('Shift+F5');
  await expect(win.locator('.cm-debug-exec-line')).toHaveCount(0, { timeout: 15_000 });
  // 停止 = disconnect:会话拆除(debuggee 结束事件可能先到,list 短暂显示 terminated)
  await expect
    .poll(async () => (await mcp.call<{ sessions: unknown[] }>('debug.list_sessions', {})).sessions, { timeout: 15_000 })
    .toEqual([]);
  await expect(win.getByRole('log')).not.toContainText('after');
});
