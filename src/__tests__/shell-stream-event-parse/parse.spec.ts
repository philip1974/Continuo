// 边界(E175,E168-E174 同族 IPC ingress 纵深防御):plugin-shell-stream:event payload 解析守卫。
// preload handler 复用本纯函数,据分类:invalid 合成 exit / 合法照常(归属由 preload 分发器先判)。防畸形事件让 preload listener 抛或喂错 chunk/exitInfo 给插件 stream。
import { describe, it, expect } from 'vitest';
import { parseShellStreamEvent } from '../../../electron/shared/plugin-shell-stream-channels';

const SID = 'stream-1';

describe('parseShellStreamEvent (E175)', () => {
  it('本 stream 但 kind 非法 / payload 形态非法 → invalid(收敛本 stream)', () => {
    expect(parseShellStreamEvent({ streamId: SID, kind: 'bogus' }).kind).toBe('invalid');
    // exit payload 非对象
    expect(parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: 'x' }).kind).toBe('invalid');
    // exit payload exitCode 非 number|null
    expect(parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: 'x', signal: null } }).kind).toBe('invalid');
    // exit payload signal 非 string|null
    expect(parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: 0, signal: 9 } }).kind).toBe('invalid');
    // stdout payload 非二进制
    expect(parseShellStreamEvent({ streamId: SID, kind: 'stdout', payload: 'not bytes' }).kind).toBe('invalid');
    expect(parseShellStreamEvent({ streamId: SID, kind: 'stdout', payload: { 0: 1 } }).kind).toBe('invalid');
  });

  it('合法 exit → {kind:exit, exitCode, signal}', () => {
    const r = parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: 137, signal: null } });
    expect(r).toEqual({ kind: 'exit', exitCode: 137, signal: null });
    const r2 = parseShellStreamEvent({ streamId: SID, kind: 'exit', payload: { exitCode: null, signal: 'SIGKILL' } });
    expect(r2).toEqual({ kind: 'exit', exitCode: null, signal: 'SIGKILL' });
  });

  it('合法 stdout/stderr(Uint8Array)→ {kind:chunk, stream, bytes}(拷贝)', () => {
    const src = new Uint8Array([1, 2, 3]);
    const r = parseShellStreamEvent({ streamId: SID, kind: 'stdout', payload: src });
    expect(r.kind).toBe('chunk');
    if (r.kind !== 'chunk') throw new Error('expected chunk');
    expect(r.stream).toBe('stdout');
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
    // 拷贝:改源不影响已解析 bytes
    src[0] = 99;
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
  });
});
