// BDD: terminal-file-links / 2-3 main 解析:按终端 cwd → 工作区根解析相对路径,只认存在的普通文件;IPC 仅本窗口会话
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

vi.mock('electron', () => ({ app: { getPath: vi.fn((k: string) => `/tmp/test-${k}`), on: vi.fn() }, BrowserWindow: {} }));

import { resolveTerminalLinkPaths } from '../../../electron/main/services/terminal-link-resolver';
import { makeResolveLinksHandler, resolveLinksInputSchema } from '../../../electron/main/ipc/terminal.ipc';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import { TERMINAL_CHANNELS } from '../../../electron/shared/terminal-channels';

let root: string;
let cwd: string;
let home: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-links-')));
  cwd = path.join(root, 'pkg');
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x\n');
  fs.writeFileSync(path.join(root, 'only-in-root.ts'), 'x\n');
  fs.writeFileSync(path.join(home, 'notes.md'), 'x\n');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveTerminalLinkPaths', () => {
  it('相对路径先按终端 cwd,再按工作区根;~/ 按 home;绝对路径原样', async () => {
    const out = await resolveTerminalLinkPaths(
      ['src/a.ts', 'only-in-root.ts', '~/notes.md', path.join(cwd, 'src', 'a.ts'), './src/a.ts'],
      [cwd, root],
      home,
    );
    expect(out).toEqual([
      path.join(cwd, 'src', 'a.ts'),
      path.join(root, 'only-in-root.ts'),
      path.join(home, 'notes.md'),
      path.join(cwd, 'src', 'a.ts'),
      path.join(cwd, 'src', 'a.ts'),
    ]);
  });
  it('不存在 / 目录 → null(不显示链接);相对路径没有可用 base → null', async () => {
    expect(await resolveTerminalLinkPaths(['nope.ts', 'src', cwd], [cwd], home)).toEqual([null, null, null]);
    expect(await resolveTerminalLinkPaths(['src/a.ts'], ['relative-base'], home)).toEqual([null]);
  });
  it.runIf(process.platform !== 'win32')('FIFO / 设备文件不是普通文件 → null(打开会阻塞读)', async () => {
    const fifo = path.join(root, 'pipe.ts');
    execFileSync('mkfifo', [fifo]);
    expect(await resolveTerminalLinkPaths([fifo, '/dev/zero'], [cwd], home)).toEqual([null, null]);
  });
});

describe('terminal:resolve_links IPC', () => {
  beforeEach(() => {
    terminalSessions._reset();
    terminalSessions.add({ id: 't', title: 'T', cwd, originHint: 'user', ownerWindowId: 1 });
  });
  it('通道名;按会话 cwd 与本窗口工作区根解析', async () => {
    expect(TERMINAL_CHANNELS.RESOLVE_LINKS).toBe('terminal:resolve_links');
    const handler = makeResolveLinksHandler({ workspaceRootOf: (id) => (id === 1 ? root : null), home: () => home });
    expect(await handler({ id: 't', paths: ['src/a.ts', 'only-in-root.ts', 'nope.ts'] }, makeWindow(1))).toEqual([
      path.join(cwd, 'src', 'a.ts'),
      path.join(root, 'only-in-root.ts'),
      null,
    ]);
  });
  it('cwd 随 OSC 7 更新后按新 cwd 解析', async () => {
    terminalSessions.updateCwd('t', path.join(cwd, 'src'));
    const handler = makeResolveLinksHandler({ workspaceRootOf: () => null, home: () => home });
    expect(await handler({ id: 't', paths: ['a.ts'] }, makeWindow(1))).toEqual([path.join(cwd, 'src', 'a.ts')]);
  });
  it('只允许本窗口会话;候选 ≤ 10 个', () => {
    const handler = makeResolveLinksHandler({ workspaceRootOf: () => null, home: () => home });
    expect(() => handler({ id: 't', paths: ['src/a.ts'] }, makeWindow(2))).toThrow(/not found/);
    expect(resolveLinksInputSchema.safeParse({ id: 't', paths: Array(10).fill('a.ts') }).success).toBe(true);
    expect(resolveLinksInputSchema.safeParse({ id: 't', paths: Array(11).fill('a.ts') }).success).toBe(false);
    expect(resolveLinksInputSchema.safeParse({ id: 't', paths: [''] }).success).toBe(false);
  });
});
