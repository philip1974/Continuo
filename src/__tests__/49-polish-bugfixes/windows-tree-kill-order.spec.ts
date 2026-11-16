// Windows 进程树终止顺序(终审 P1):`taskkill /T /F` 靠根 PID 遍历子进程,必须等它结束后才对根进程兜底直杀;
// 否则根进程先死,taskkill 稍后执行时已无从遍历,后代成孤儿。见同目录 README.md。
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: h.spawn };
});

import {
  TASKKILL_WAIT_MS,
  killProcessTreesNow,
  processTreeKillable,
} from '../../../electron/main/lib/kill-with-grace';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function fakeChild() {
  const ev = new EventEmitter();
  const child = {
    pid: 4321,
    kill: vi.fn((_sig?: NodeJS.Signals | number) => true),
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    once: (e: 'close', fn: () => void) => ev.once(e, fn),
  };
  return { child, ev };
}

let taskkill: EventEmitter;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  taskkill = new EventEmitter();
  h.spawn.mockReset().mockImplementation(() => taskkill);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.useRealTimers();
});

describe('49 · Windows 进程树终止:先等 taskkill 结束,再直杀根进程', () => {
  it('killProcessTreesNow:taskkill 结束前不直杀根进程;结束后才兜底 SIGKILL', async () => {
    const { child, ev } = fakeChild();
    const done = killProcessTreesNow([child], 2000);
    expect(h.spawn).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F'], expect.anything());
    await Promise.resolve();
    expect(child.kill).not.toHaveBeenCalled();

    taskkill.emit('exit', 0);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'));
    ev.emit('close');
    await done;
  });

  it('taskkill 迟迟不结束 → 等待上限到点仍兜底直杀根进程', async () => {
    vi.useFakeTimers();
    const { child } = fakeChild();
    const t = processTreeKillable(child);
    t.kill('SIGTERM');
    t.kill('SIGKILL');
    await vi.advanceTimersByTimeAsync(TASKKILL_WAIT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('taskkill 启动失败(error)→ 立即直杀根进程', async () => {
    const { child } = fakeChild();
    const t = processTreeKillable(child);
    t.kill('SIGTERM');
    taskkill.emit('error', new Error('ENOENT'));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('未发过 SIGTERM 的 SIGKILL → 直接直杀(不等待)', () => {
    const { child } = fakeChild();
    processTreeKillable(child).kill('SIGKILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
