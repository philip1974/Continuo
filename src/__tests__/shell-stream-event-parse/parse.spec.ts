// 边界(E175,E168-E174 同族 IPC ingress 纵深防御):plugin-shell-stream:event payload 解析守卫。
// preload handler 复用本纯函数,据分类:not-ours 忽略 / unattributable drop / invalid 合成 exit /
// 合法照常。防畸形事件让 preload listener 抛或喂错 chunk/exitInfo 给插件 stream。
import { describe, it, expect } from 'vitest';
import { parseShellStreamEvent } from '../../../electron/shared/plugin-shell-stream-channels';

const SID = 'stream-1';

describe('parseShellStreamEvent (E175)', () => {
  it('null / 非对象 / streamId 非串 → unattributable(不归属,不动本 stream)', () => {
    expect(parseShellStreamEvent(null, SID).kind).toBe('unattributable');
    expect(parseShellStreamEvent('s', SID).kind).toBe('unattributable');
    expect(parseShellStreamEvent(42, SID).kind).toBe('unattributable');
    expect(parseShellStreamEvent({ kind: 'exit' }, SID).kind).toBe('unattributable'); // 无 streamId
    expect(parseShellStreamEvent({ streamId: 123 }, SID).kind).toBe('unattributable');
  });

  it('streamId ≠ 本 stream → not-ours(静默忽略)', () => {
    expect(parseShellStreamEvent({ streamId: 'other', kind: 'exit', payload: { exitCode: 0, signal: null } }, SID).kind).toBe('not-ours');
  });

  it('本 stream 但 kind 非法 / payload 形态非法 → invalid(收敛本 stream)', () => {
    expect(parseShellStreamEvent({ streamId: SID, kind: 'bogus' }, SID).kind).toBe('invalid');
    // exit payload 非对象
    expect(parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: 'x' }, SID).kind).toBe('invalid');
    // exit payload exitCode 非 number|null
    expect(parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: 'x', signal: null } }, SID).kind).toBe('invalid');
    // exit payload signal 非 string|null
    expect(parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: 0, signal: 9 } }, SID).kind).toBe('invalid');
    // stdout payload 非二进制
    expect(parseShellStreamEvent({ streamId: SID, kind: 'stdout', payload: 'not bytes' }, SID).kind).toBe('invalid');
    expect(parseShellStreamEvent({ streamId: SID, kind: 'stdout', payload: { 0: 1 } }, SID).kind).toBe('invalid');
  });

  it('合法 exit → {kind:exit, exitCode, signal}', () => {
    const r = parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: 137, signal: null } }, SID);
    expect(r).toEqual({ kind: 'exit', exitCode: 137, signal: null });
    const r2 = parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: null, signal: 'SIGKILL' } }, SID);
    expect(r2).toEqual({ kind: 'exit', exitCode: null, signal: 'SIGKILL' });
  });

  it('合法 stdout/stderr(Uint8Array)→ {kind:chunk, stream, bytes}(拷贝)', () => {
    const src = new Uint8Array([1, 2, 3]);
    const r = parseShellStreamEvent({ streamId: SID, kind: 'stdout', payload: src }, SID);
    expect(r.kind).toBe('chunk');
    if (r.kind !== 'chunk') throw new Error('expected chunk');
    expect(r.stream).toBe('stdout');
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
    // 拷贝:改源不影响已解析 bytes
    src[0] = 99;
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
  });
});
