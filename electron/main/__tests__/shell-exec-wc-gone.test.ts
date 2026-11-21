// 终审 P1:一次性 shell.exec 在所属窗口关闭 / 整页重载后回收。此前进程只登记 (senderId, pluginId),
// 窗口销毁或 reload 后 detached 子进程继续跑到超时,并占着全局 / 单 sender 名额。
// 对照流式 shell(plugin-shell-stream)的 wc-gone 钩子:destroyed 与 main frame 非同文档导航都终止该 sender 名下全部 exec。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const spawnedChildren: FakeChild[] = [];
class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { destroy() {} });
  readonly stderr = Object.assign(new EventEmitter(), { destroy() {} });
  readonly stdin = Object.assign(new EventEmitter(), { write() {}, end() {} });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  private closed = false;
  kill(sig: NodeJS.Signals): boolean {
    this.signals.push(sig);
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close', null, sig));
    }
    return true;
  }
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 0, null);
  }
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild();
    spawnedChildren.push(c);
    return c;
  },
}));

import {
  attachShellExecWcGoneHook,
  execShell,
  MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST,
} from '../services/shell.service';

class FakeWc extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

const input = { cmd: 'node', args: [], pluginId: 'com.x.p' };

afterEach(() => {
  for (const c of spawnedChildren) c.finish();
  spawnedChildren.length = 0;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('shell.exec 随所属 webContents 回收', () => {
  it('webContents destroyed → 该 sender 的 exec 全部终止;其它 sender 不受影响', async () => {
    const wcA = new FakeWc(501);
    const wcB = new FakeWc(502);
    attachShellExecWcGoneHook(wcA as never);
    attachShellExecWcGoneHook(wcB as never);
    const a1 = execShell(input, 501);
    const a2 = execShell(input, 501);
    void execShell(input, 502);
    const [cA1, cA2, cB] = spawnedChildren;
    wcA.emit('destroyed');
    await Promise.all([a1, a2]);
    expect(cA1!.signals).toContain('SIGKILL');
    expect(cA2!.signals).toContain('SIGKILL');
    expect(cB!.signals).toEqual([]);
  });

  it('整页 reload(main frame 非同文档导航)→ 终止并释放名额;in-page / 子 frame 导航不终止', async () => {
    const wc = new FakeWc(503);
    attachShellExecWcGoneHook(wc as never);
    const max = MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST;
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < max; i++) pending.push(execShell(input, 503));
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    await flush();
    expect(spawnedChildren.every((c) => c.signals.length === 0)).toBe(true);
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await Promise.all(pending);
    // 名额已释放:同一 sender 可再 exec
    const before = spawnedChildren.length;
    void execShell(input, 503);
    expect(spawnedChildren.length).toBe(before + 1);
  });
});
