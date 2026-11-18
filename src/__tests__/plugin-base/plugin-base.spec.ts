import { describe, it, expect, vi } from 'vitest';
import { Plugin, type Disposable } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { CoPluginApp, PluginManifest } from '../../plugins/types';

// ── 测试夹具 ─────────────────────────────────────────────

const fakeApp = createTestApp('0.0.0-test');

const baseManifest: PluginManifest = {
  id: 'test.plugin',
  name: 'Test',
  version: '0.1.0',
};

class NoopPlugin extends Plugin {
  onload(): void {}
}

function makeDisposable(label: string, log: string[]): Disposable {
  return { dispose: () => log.push(label) };
}

// ── Plugin 抽象 API ──────────────────────────────────────

describe('Plugin 构造', () => {
  it('暴露 app / manifest 只读', () => {
    const p = new NoopPlugin(fakeApp, baseManifest);
    expect(p.app).toBe(fakeApp);
    expect(p.manifest).toBe(baseManifest);
  });
});

// ── Disposable LIFO 清理 ─────────────────────────────────

describe('Disposable LIFO', () => {
  it('多次 register 后 _deactivate 反序清理(后入先出)', async () => {
    const log: string[] = [];
    class P extends Plugin {
      onload() {
        this.register(makeDisposable('A', log));
        this.register(makeDisposable('B', log));
        this.register(makeDisposable('C', log));
      }
    }
    const p = new P(fakeApp, baseManifest);
    await p._activate();
    await p._deactivate();
    expect(log).toEqual(['C', 'B', 'A']);
  });

  it('单个 dispose 抛错不影响其他 dispose', async () => {
    const log: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class P extends Plugin {
      onload() {
        this.register(makeDisposable('A', log));
        this.register({
          dispose: () => {
            throw new Error('boom');
          },
        });
        this.register(makeDisposable('C', log));
      }
    }
    const p = new P(fakeApp, baseManifest);
    await p._activate();
    await p._deactivate();
    expect(log).toEqual(['C', 'A']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('register 返回原 Disposable 便于链式', async () => {
    let captured: Disposable | null = null;
    class P extends Plugin {
      onload() {
        const d = makeDisposable('X', []);
        captured = this.register(d);
        expect(captured).toBe(d);
      }
    }
    const p = new P(fakeApp, baseManifest);
    await p._activate();
    expect(captured).not.toBeNull();
  });

  it('未 register 任何 d 也能干净 _deactivate', async () => {
    const p = new NoopPlugin(fakeApp, baseManifest);
    await p._activate();
    await expect(p._deactivate()).resolves.toBeUndefined();
  });
});

// ── 生命周期幂等性 ──────────────────────────────────────

describe('生命周期幂等', () => {
  it('_deactivate 二次调用 → 不重复 dispose', async () => {
    const log: string[] = [];
    class P extends Plugin {
      onload() {
        this.register(makeDisposable('A', log));
      }
    }
    const p = new P(fakeApp, baseManifest);
    await p._activate();
    await p._deactivate();
    await p._deactivate();
    expect(log).toEqual(['A']);
  });

  it('_deactivate 后再 _activate → 抛错(不可复用)', async () => {
    const p = new NoopPlugin(fakeApp, baseManifest);
    await p._activate();
    await p._deactivate();
    await expect(p._activate()).rejects.toThrow(/already deactivated/i);
  });

  it('_deactivate 后再 register(d) → 立即 dispose 该 d 并返回', async () => {
    const log: string[] = [];
    class P extends Plugin {
      onload() {}
      // 暴露 register 给测试调(register 是 protected,需子类内代理)
      callRegister(d: Disposable) {
        return this.register(d);
      }
    }
    const p = new P(fakeApp, baseManifest);
    await p._activate();
    await p._deactivate();
    const late = makeDisposable('LATE', log);
    const ret = (p as P).callRegister(late);
    expect(ret).toBe(late);
    expect(log).toEqual(['LATE']);
  });
});

// ── 异步 hooks ──────────────────────────────────────────

describe('异步 onload / onunload', () => {
  it('await async onload', async () => {
    const order: string[] = [];
    class P extends Plugin {
      async onload() {
        await new Promise((r) => setTimeout(r, 5));
        order.push('loaded');
      }
    }
    const p = new P(fakeApp, baseManifest);
    await p._activate();
    order.push('after_activate');
    expect(order).toEqual(['loaded', 'after_activate']);
  });

  it('onload 抛错向上传(不被父类吞)', async () => {
    class P extends Plugin {
      onload() {
        throw new Error('init failure');
      }
    }
    const p = new P(fakeApp, baseManifest);
    await expect(p._activate()).rejects.toThrow('init failure');
  });

  it('onload 抛错前已 register 的 disposables 被 LIFO 清理(防泄漏)', async () => {
    const log: string[] = [];
    class P extends Plugin {
      onload() {
        this.register(makeDisposable('A', log));
        this.register(makeDisposable('B', log));
        throw new Error('init failure after partial register');
      }
    }
    const p = new P(fakeApp, baseManifest);
    await expect(p._activate()).rejects.toThrow('init failure');
    // 已 register 的 A / B 必须被清理(LIFO),否则注册到 panel/command/mcp
    // 等 registry 的贡献会泄漏到 app 单例里。
    expect(log).toEqual(['B', 'A']);
  });

  it('onload 抛错时不调 onunload(plugin 没完成初始化,业务 unload 钩子无意义)', async () => {
    let onunloadCalled = false;
    class P extends Plugin {
      onload() {
        this.register(makeDisposable('A', []));
        throw new Error('boom');
      }
      onunload() {
        onunloadCalled = true;
      }
    }
    const p = new P(fakeApp, baseManifest);
    await expect(p._activate()).rejects.toThrow('boom');
    expect(onunloadCalled).toBe(false);
  });

  it('_activate 失败后 disposed=true,再 _activate / _deactivate 不重复清理', async () => {
    const log: string[] = [];
    class P extends Plugin {
      onload() {
        this.register(makeDisposable('A', log));
        throw new Error('boom');
      }
    }
    const p = new P(fakeApp, baseManifest);
    await expect(p._activate()).rejects.toThrow('boom');
    expect(log).toEqual(['A']);
    // 二次 _activate 抛"already deactivated"
    await expect(p._activate()).rejects.toThrow(/already deactivated/i);
    // _deactivate 幂等不重复清理
    await p._deactivate();
    expect(log).toEqual(['A']);
  });

  it('onunload 在所有 dispose 后调用', async () => {
    const order: string[] = [];
    class P extends Plugin {
      onload() {
        this.register({ dispose: () => order.push('disp_A') });
      }
      onunload() {
        order.push('onunload');
      }
    }
    const p = new P(fakeApp, baseManifest);
    await p._activate();
    await p._deactivate();
    expect(order).toEqual(['disp_A', 'onunload']);
  });
});

// ── 提前 dispose 的贡献句柄不滞留 ─────────────────────────
// perf P2:插件刷新装饰的唯一方式是 dispose 旧 decorator 再重新注册;反复 registerEvent/dispose 同理。
// 提前 dispose 的句柄若仍留在 Plugin 的收集集合里,会把 registry 闭包与插件回调一直留到停用。

describe('提前 dispose 的贡献句柄从收集集合移除', () => {
  function countingApp() {
    let disposeCalls = 0;
    // scoped app 的贡献点命名空间是冻结外观,不能原地改写:换一个带计数 register 的命名空间。
    const base = createTestApp('0.0.0-test');
    const app: CoPluginApp = {
      ...base,
      explorerDecorators: {
        ...base.explorerDecorators,
        register: (fn) => {
          const d = base.explorerDecorators.register(fn);
          return { dispose: () => { disposeCalls++; d.dispose(); } };
        },
      },
    };
    return { app, calls: () => disposeCalls };
  }
  const collectedSize = (p: Plugin): number =>
    (p as unknown as { disposables: { size: number } }).disposables.size;

  it('反复 registerExplorerDecorator → dispose N 次:集合不增长,停用不再重复 dispose 已释放的句柄', async () => {
    const { app, calls } = countingApp();
    class P extends Plugin {
      onload() {}
      refresh() {
        return this.registerExplorerDecorator(() => null);
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    for (let i = 0; i < 50; i++) p.refresh().dispose();
    p.refresh();
    expect(collectedSize(p)).toBe(1);
    expect(calls()).toBe(50);
    await p._deactivate();
    // 停用只释放仍存活的 1 个
    expect(calls()).toBe(51);
    expect(app.explorerDecorators.getAll()).toHaveLength(0);
  });

  it('反复 registerEvent → dispose N 次:集合不增长;停用时仍存活的订阅全部释放', async () => {
    const app = createTestApp('0.0.0-test');
    const got: unknown[] = [];
    class P extends Plugin {
      onload() {
        this.registerEvent({ name: 'keep', fn: (x) => got.push(x) });
      }
      churn() {
        this.registerEvent({ name: 'tmp', fn: () => {} }).dispose();
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    for (let i = 0; i < 50; i++) p.churn();
    expect(collectedSize(p)).toBe(1);
    app.events.emit('keep', 1);
    await p._deactivate();
    app.events.emit('keep', 2);
    expect(got).toEqual([1]);
  });

  it('停用时按注册逆序释放仍存活的贡献句柄(中途 dispose 的不参与)', async () => {
    const log: string[] = [];
    const base = createTestApp('0.0.0-test');
    let n = 0;
    const app: CoPluginApp = {
      ...base,
      commands: {
        ...base.commands,
        register: () => {
          const label = `C${n++}`;
          return { dispose: () => log.push(label) };
        },
      },
    };
    class P extends Plugin {
      onload() {
        this.addCommand({ id: 'a', title: 'a', fn: () => {} });
        const mid = this.addCommand({ id: 'b', title: 'b', fn: () => {} });
        this.register(makeDisposable('R', log));
        this.addCommand({ id: 'c', title: 'c', fn: () => {} });
        mid.dispose();
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    expect(log).toEqual(['C1']);
    await p._deactivate();
    expect(log).toEqual(['C1', 'C2', 'R', 'C0']);
  });
});
