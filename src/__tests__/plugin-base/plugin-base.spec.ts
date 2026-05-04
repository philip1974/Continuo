import { describe, it, expect, vi } from 'vitest';
import { Plugin, type Disposable } from '../../plugins/Plugin';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';
import type { LMApp, PluginManifest } from '../../plugins/types';

// ── 测试夹具 ─────────────────────────────────────────────

const fakeApp: LMApp = {
  version: '0.0.0-test',
  panels: new PanelRegistry(),
  commands: new CommandRegistry(),
  statusBar: new StatusBarRegistry(),
};

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
