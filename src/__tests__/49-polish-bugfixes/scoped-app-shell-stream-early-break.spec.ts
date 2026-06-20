// @vitest-environment jsdom
// topic 49 第十四轮 · P2-AM/P2-AN:plugin shell stream 提前 break 要 abort 子进程;
// done 急切 reject 不得成 unhandledrejection。
//
// P2-AM 根因:app.shell.execStream 的 chunks 异步迭代器(scoped-app 外层 + preload 内层)
// 都只实现 next() 没 return()。插件 `for await(chunks){ break }` 时 JS 调 iterator.return(),
// 缺这个钩子 → 永不发 ABORT → 主进程子进程挂到 timeout(最长 30min)+ handler 驻留 +
// chunkQueue 无界堆积。修复:两层都补 return(),外层委托内层、内层 invoke ABORT。
//
// P2-AN 根因:done = start().then(...) 急切求值,start() 的 ensurePerm 缺 shell 权限时
// 立即 reject。插件只迭代 chunks(合法)不引用 done → 无人处理 → unhandledrejection 噪声。
// 修复:给 done 挂 no-op .catch 标记 handled,但真实 await done 仍能看到 reject。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const returnSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/co-api', () => ({
  coApi: {
    shell: { exec: vi.fn() },
    pluginShellStreamRaw: {
      execStream: vi.fn(() => ({
        chunks: {
          [Symbol.asyncIterator]() {
            let yielded = false;
            return {
              async next() {
                if (!yielded) {
                  yielded = true;
                  return { value: { stream: 'stdout', chunk: new Uint8Array([1]) }, done: false };
                }
                // 之后永不结束(模拟 tail -f),逼插件靠 break 跳出
                return new Promise(() => {});
              },
              async return() {
                returnSpy();
                return { value: undefined, done: true };
              },
            };
          },
        },
        done: new Promise(() => {}),
      })),
    },
  },
}));

import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import { InMemoryPermissionStore } from '../../plugins/permissions';
import type { CoApp } from '../../plugins/types';

function makeApp(): CoApp {
  return createTestCoApp('1.0.0');
}

beforeEach(() => {
  returnSpy.mockClear();
});

describe('topic49 P2-AM · 提前 break 触发内层 iterator.return()(abort)', () => {
  it('for await 中 break → 外层 return() 委托内层 return()', async () => {
    const app = createScopedApp(makeApp(), 'p', null); // store=null → shell 允许
    const stream = app.shell.execStream('tail', ['-f', 'x']);

    let count = 0;
    for await (const _c of stream.chunks) {
      count += 1;
      break; // 读一条就跳出
    }
    expect(count).toBe(1);
    // break 必须触达内层 iterator.return()(否则子进程挂到 timeout)
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('topic49 P2-AN · done 急切 reject 仍可被 await 观测(不静默吞)', () => {
  it('缺 shell 权限:await done 抛出,且不影响真实消费方拿到错误', async () => {
    const store = new InMemoryPermissionStore();
    await store.deny('p', ['shell']);
    const app = createScopedApp(makeApp(), 'p', store);

    const stream = app.shell.execStream('ls', []);
    // 真实消费方 await done 仍能看到 reject(no-op .catch 只防 unhandled,不吞 reject)
    await expect(stream.done).rejects.toBeTruthy();
  });
});
