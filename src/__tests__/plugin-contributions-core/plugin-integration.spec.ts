import { describe, it, expect } from 'vitest';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const makeApp = () => createTestApp();

const manifest: PluginManifest = {
  id: 'test.contrib',
  name: 'Contrib',
  version: '0.1.0',
};

describe('Plugin 贡献点代理 + 自动 dispose', () => {
  it('registerPanel 在 _deactivate 时自动从 registry 移除', async () => {
    const app = makeApp();
    class P extends Plugin {
      onload() {
        this.registerPanel({ type: 'mine', factory: () => null, title: 'Mine' });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.panels.getAll().map((x) => x.type)).toEqual(['mine']);
    await p._deactivate();
    expect(app.panels.getAll()).toEqual([]);
  });

  it('addCommand 在 _deactivate 时自动从 registry 移除', async () => {
    const app = makeApp();
    class P extends Plugin {
      onload() {
        this.addCommand({ id: 'mine.do', title: 'Do', fn: () => {} });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.commands.getAll().map((x) => x.id)).toEqual(['mine.do']);
    await p._deactivate();
    expect(app.commands.getAll()).toEqual([]);
  });

  it('addStatusBarItem 在 _deactivate 时自动从 registry 移除', async () => {
    const app = makeApp();
    class P extends Plugin {
      onload() {
        this.addStatusBarItem({
          id: 'mine.git',
          side: 'left',
          render: () => null,
        });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.statusBar.getBySide('left').map((x) => x.id)).toEqual([
      'mine.git',
    ]);
    await p._deactivate();
    expect(app.statusBar.getBySide('left')).toEqual([]);
  });

  it('多贡献混合 + LIFO 清理顺序', async () => {
    const app = makeApp();
    const order: string[] = [];
    class P extends Plugin {
      onload() {
        const panelD = this.registerPanel({
          type: 'p',
          factory: () => null,
          title: 'P',
        });
        const cmdD = this.addCommand({
          id: 'c',
          title: 'C',
          fn: () => {},
        });
        const sbD = this.addStatusBarItem({
          id: 's',
          side: 'right',
          render: () => null,
        });
        // 拦截原 dispose 记录顺序
        const wrap = (label: string, d: { dispose(): void }) => ({
          dispose: () => {
            order.push(label);
            d.dispose();
          },
        });
        // 重新注册 wrap 版本(原 d 提前 dispose 没影响)
        panelD.dispose();
        cmdD.dispose();
        sbD.dispose();
        // 用包装 d 重新走一遍
        this.register(
          wrap(
            'panel',
            this.app.panels.register({
              type: 'p',
              factory: () => null,
              title: 'P',
            }),
          ),
        );
        this.register(
          wrap(
            'cmd',
            this.app.commands.register({
              id: 'c',
              title: 'C',
              fn: () => {},
            }),
          ),
        );
        this.register(
          wrap(
            'sb',
            this.app.statusBar.register({
              id: 's',
              side: 'right',
              render: () => null,
            }),
          ),
        );
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    await p._deactivate();
    expect(order).toEqual(['sb', 'cmd', 'panel']);
  });
});
