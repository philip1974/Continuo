// race(R16):wirePluginReloadGate —— init 完成前到达的 onChanged 须缓冲(去重),init 完成后
// 逐个 reload,避免启动窗口期变更被「Plugin not found」丢弃。
import { describe, it, expect, vi } from 'vitest';
import { wirePluginReloadGate } from '../../plugins/plugin-reload-gate';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('wirePluginReloadGate (R16)', () => {
  it('init 完成前的 onChanged 缓冲,完成后逐个 reload(去重)', async () => {
    const initD = deferred();
    const reload = vi.fn().mockResolvedValue(undefined);
    let changedCb!: (id: string) => void;

    wirePluginReloadGate({
      init: () => initD.promise,
      reload,
      onChanged: (cb) => {
        changedCb = cb;
      },
    });

    // init 未完成 → 变更只缓冲,不 reload
    changedCb('a');
    changedCb('b');
    changedCb('a'); // 去重
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    // init 完成 → flush 缓冲(去重后 a、b 各一次)
    initD.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const reloaded = reload.mock.calls.map((c) => c[0]).sort();
    expect(reloaded).toEqual(['a', 'b']);
  });

  it('init 完成后的 onChanged 直接 reload', async () => {
    const initD = deferred();
    const reload = vi.fn().mockResolvedValue(undefined);
    let changedCb!: (id: string) => void;

    wirePluginReloadGate({
      init: () => initD.promise,
      reload,
      onChanged: (cb) => {
        changedCb = cb;
      },
    });

    initD.resolve();
    await Promise.resolve();
    await Promise.resolve();

    changedCb('c');
    await Promise.resolve();
    expect(reload).toHaveBeenCalledWith('c');
  });

  it('init 失败也 flush 缓冲并标 ready(否则变更永久 buffer)', async () => {
    const initD = deferred();
    const reload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    let changedCb!: (id: string) => void;

    wirePluginReloadGate({
      init: () => initD.promise,
      reload,
      onChanged: (cb) => {
        changedCb = cb;
      },
      onError,
    });

    changedCb('x'); // 缓冲
    initD.reject(new Error('init boom'));
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('init', expect.any(Error));
    expect(reload).toHaveBeenCalledWith('x'); // flush 后重放
    // 之后的变更直接 reload(已 ready)
    changedCb('y');
    await Promise.resolve();
    expect(reload).toHaveBeenCalledWith('y');
  });

  it('reload 失败 → onError(reload) 不抛', async () => {
    const initD = deferred();
    const reload = vi.fn().mockRejectedValue(new Error('reload boom'));
    const onError = vi.fn();
    let changedCb!: (id: string) => void;

    wirePluginReloadGate({
      init: () => initD.promise,
      reload,
      onChanged: (cb) => {
        changedCb = cb;
      },
      onError,
    });
    initD.resolve();
    await Promise.resolve();
    await Promise.resolve();

    changedCb('z');
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('reload', expect.any(Error));
  });
});
