// 性能:execShell 某个输出流达到 maxOutputBytes 后,此前 data listener 仍逐 chunk 进 JS 回调(只是立即
// return),`yes` / 失控日志可在 main 热路径空转到超时。达上限后该流须摘掉 JS data 处理、切为丢弃式
// drain(仍 flowing,不反压子进程);截断标志、结果内容、exit/close 语义不变。
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ child: null as null | FakeChild }));

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
}

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.pid = undefined;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => true;
      h.child = child;
      return child;
    }),
  };
});

import { execShell } from '../../../electron/main/services/shell.service';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('49 · execShell 达上限后丢弃式 drain', () => {
  it('超上限:该流摘掉 data 处理、继续 flowing 丢弃;另一流不受影响;结果与截断标志不变', async () => {
    const p = execShell({ cmd: 'x', args: [], maxOutputBytes: 4 });
    const child = h.child!;
    child.stdout.write(Buffer.from('abcdef'));
    child.stderr.write(Buffer.from('xy'));
    await tick();

    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stdout.readableFlowing).toBe(true);
    expect(child.stderr.listenerCount('data')).toBe(1);

    for (let i = 0; i < 50; i++) child.stdout.write(Buffer.alloc(64 * 1024, 0x61));
    await tick();
    expect(child.stdout.readableLength).toBe(0); // 已丢弃,不积压 / 不反压

    child.emit('close', 0, null);
    const r = await p;
    expect(r).toMatchObject({ stdout: 'abcd', stderr: 'xy', exitCode: 0, truncated: true });
  });

  it('恰好写满上限且之后无输出 → truncated=false;之后再来数据 → truncated=true', async () => {
    const p1 = execShell({ cmd: 'x', args: [], maxOutputBytes: 4 });
    const c1 = h.child!;
    c1.stdout.write(Buffer.from('abcd'));
    await tick();
    c1.emit('close', 0, null);
    expect(await p1).toMatchObject({ stdout: 'abcd', truncated: false });

    const p2 = execShell({ cmd: 'x', args: [], maxOutputBytes: 4 });
    const c2 = h.child!;
    c2.stdout.write(Buffer.from('abcd'));
    await tick();
    c2.stdout.write(Buffer.from('e'));
    c2.stdout.write(Buffer.from('f'));
    await tick();
    expect(c2.stdout.listenerCount('data')).toBe(0);
    c2.emit('close', 0, null);
    expect(await p2).toMatchObject({ stdout: 'abcd', truncated: true });
  });
});
