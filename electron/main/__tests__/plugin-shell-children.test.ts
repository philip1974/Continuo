// lib/plugin-shell-children:插件 shell 子进程(一次性 exec / 流式)共用的在途登记、退出闸、容量双闸、
// 按 sender / 按 (sender, 插件) 终止,以及超时终止链与 timeout clamp。用无 pid 的假子进程(processTreeKillable
// 回退直杀 child.kill),kill 即 emit close,不起真实进程。
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHELL_MAX_TIMEOUT_MS } from '../../shared/shell-limits';
import {
  clampShellTimeoutMs,
  createPluginShellChildren,
  FORCE_SETTLE_MS,
  killPluginShellProcesses,
  killTreeWithForceSettle,
} from '../lib/plugin-shell-children';

class Fake extends EventEmitter {
  readonly signals: string[] = [];
  readonly stdout = { destroy: vi.fn() };
  readonly stderr = { destroy: vi.fn() };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** false:吞掉信号不退出(模拟忽略 SIGTERM / 后代持管道)。 */
  constructor(private readonly diesOnKill = true) {
    super();
  }
  kill(sig?: string): boolean {
    this.signals.push(String(sig));
    if (this.diesOnKill && this.signals.length === 1) queueMicrotask(() => this.emit('close', null, sig));
    return true;
  }
  get asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

const live: Fake[] = [];
function fake(diesOnKill = true): Fake {
  const f = new Fake(diesOnKill);
  live.push(f);
  return f;
}

afterEach(() => {
  for (const f of live.splice(0)) f.emit('close', 0, null);
  vi.useRealTimers();
});

describe('clampShellTimeoutMs', () => {
  it('非有限 / ≤0 / 非数字 / 缺省 → 默认值', () => {
    for (const v of [undefined, NaN, Infinity, -Infinity, 0, -5, '100', null]) {
      expect(clampShellTimeoutMs(v, 1234)).toBe(1234);
    }
  });
  it('有限正数取整并封顶到 SHELL_MAX_TIMEOUT_MS', () => {
    expect(clampShellTimeoutMs(200.9, 1)).toBe(200);
    expect(clampShellTimeoutMs(2e9, 1)).toBe(SHELL_MAX_TIMEOUT_MS);
  });
});

describe('createPluginShellChildren 容量双闸', () => {
  it('全局 / 单 sender 上限;无 senderId 的调用只计全局', () => {
    const reg = createPluginShellChildren({ maxGlobal: 3, maxPerSender: 2 });
    reg.track(fake().asChild, 1, undefined);
    expect(reg.atCapacity(1)).toBe(false);
    reg.track(fake().asChild, 1, undefined);
    expect(reg.atCapacity(1)).toBe(true);
    expect(reg.atCapacity(2)).toBe(false);
    expect(reg.atCapacity(undefined)).toBe(false);
    reg.track(fake().asChild, undefined, undefined);
    expect(reg.atCapacity(2)).toBe(true);
    expect(reg.atCapacity(undefined)).toBe(true);
  });

  it('close / error / 显式 release 归还名额,且只归还一次', () => {
    const reg = createPluginShellChildren({ maxGlobal: 10, maxPerSender: 1 });
    const a = fake();
    reg.track(a.asChild, 1, undefined);
    a.emit('error', new Error('x'));
    a.emit('close', 0, null);
    expect(reg.atCapacity(1)).toBe(false);

    const b = fake();
    const release = reg.track(b.asChild, 1, undefined);
    expect(reg.atCapacity(1)).toBe(true);
    release();
    expect(reg.atCapacity(1)).toBe(false);
    // 已提前释放:再 track 一个占满,b 之后 close 不得重复扣减
    reg.track(fake().asChild, 1, undefined);
    b.emit('close', 0, null);
    expect(reg.atCapacity(1)).toBe(true);
  });
});

describe('createPluginShellChildren 终止', () => {
  it('killForSender 只杀该 sender 的在途进程', async () => {
    const reg = createPluginShellChildren({ maxGlobal: 10, maxPerSender: 10 });
    const a = fake();
    const b = fake();
    reg.track(a.asChild, 1, undefined);
    reg.track(b.asChild, 2, undefined);
    await reg.killForSender(1);
    expect(a.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(b.signals).toEqual([]);
  });

  it('提前 release 名额的进程仍在登记表内,退出清理照杀', async () => {
    const reg = createPluginShellChildren({ maxGlobal: 10, maxPerSender: 10 });
    const a = fake();
    reg.track(a.asChild, 1, undefined)();
    await reg.cleanupAll();
    expect(a.signals).toEqual(['SIGTERM', 'SIGKILL']);
    reg.resetShutdownForTest();
  });

  it('cleanupAll 置退出闸并补杀清理期间新登记的进程;reset 复位', async () => {
    const reg = createPluginShellChildren({ maxGlobal: 10, maxPerSender: 10 });
    const a = fake();
    const late = fake();
    reg.track(a.asChild, 1, undefined);
    a.once('close', () => reg.track(late.asChild, 1, undefined));
    expect(reg.isShuttingDown()).toBe(false);
    await reg.cleanupAll();
    expect(reg.isShuttingDown()).toBe(true);
    expect(late.signals).toEqual(['SIGTERM', 'SIGKILL']);
    reg.resetShutdownForTest();
    expect(reg.isShuttingDown()).toBe(false);
  });

  it('killPluginShellProcesses 跨各登记实例按 (sender, 插件) 终止;无插件 id 的不登记归属', async () => {
    const r1 = createPluginShellChildren({ maxGlobal: 10, maxPerSender: 10 });
    const r2 = createPluginShellChildren({ maxGlobal: 10, maxPerSender: 10 });
    const p1 = fake();
    const p2 = fake();
    const otherPlugin = fake();
    const otherSender = fake();
    const noPlugin = fake();
    const internal = fake();
    r1.track(p1.asChild, 1, 'p');
    r2.track(p2.asChild, 1, 'p');
    r1.track(otherPlugin.asChild, 1, 'q');
    r2.track(otherSender.asChild, 2, 'p');
    r1.track(noPlugin.asChild, 1, '');
    r1.track(internal.asChild, undefined, 'p');
    await killPluginShellProcesses(1, 'p');
    expect(p1.signals.length).toBeGreaterThan(0);
    expect(p2.signals.length).toBeGreaterThan(0);
    for (const f of [otherPlugin, otherSender, noPlugin, internal]) expect(f.signals).toEqual([]);
    await killPluginShellProcesses(1, '');
    expect(noPlugin.signals).toEqual([]);
  });
});

describe('killTreeWithForceSettle', () => {
  it('SIGTERM → 宽限后 SIGKILL;仍不 close 时 FORCE_SETTLE_MS 后销毁 stdio 并强制结算', () => {
    vi.useFakeTimers();
    const f = fake(false);
    const onForce = vi.fn();
    killTreeWithForceSettle(f.asChild, 500, onForce);
    expect(f.signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(500);
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL']);
    vi.advanceTimersByTime(FORCE_SETTLE_MS - 501);
    expect(onForce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.stdout.destroy).toHaveBeenCalled();
    expect(f.stderr.destroy).toHaveBeenCalled();
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  it('返回的取消函数撤销强制结算(宽限期 SIGKILL 不撤)', () => {
    vi.useFakeTimers();
    const f = fake(false);
    const onForce = vi.fn();
    const cancel = killTreeWithForceSettle(f.asChild, undefined, onForce);
    cancel();
    vi.advanceTimersByTime(FORCE_SETTLE_MS * 2);
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(onForce).not.toHaveBeenCalled();
  });
});
