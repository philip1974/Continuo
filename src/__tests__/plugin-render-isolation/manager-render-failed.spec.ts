// @vitest-environment jsdom
// BDD: plugin-render-isolation —— PluginManager 侧:渲染出错标 failed、实例保留、重试不出双实例(见同目录 README)。
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: vi.fn().mockResolvedValue({ token: 't', generation: 1 }),
      _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { createTestCoApp } from '../../plugins/test-utils';

const events: string[] = [];
class Tracked extends Plugin {
  onload(): void {
    events.push('load');
  }
  override onunload(): void {
    events.push('unload');
  }
}

async function setup() {
  events.length = 0;
  let enabled = new Set(['acme.bad']);
  const host: ManagerHost = {
    listPluginDirs: () => [
      { id: 'acme.bad', manifestText: JSON.stringify({ id: 'acme.bad', name: 'Acme Bad', version: '1.0.0' }), moduleUrl: 'm' },
    ],
    readEnabledIds: () => enabled,
    mutateEnabledId: (id, on) => {
      enabled = new Set(enabled);
      if (on) enabled.add(id);
      else enabled.delete(id);
    },
    importModule: async () => ({ default: Tracked }),
  };
  const m = new PluginManager(createTestCoApp('1.0.0'), host);
  await m.init();
  return m;
}

describe('PluginManager.markRenderFailed', () => {
  it('enabled 插件 → failed(RENDER_FAILED,message 为错误文本),实例保留(不卸载)', async () => {
    const m = await setup();
    m.markRenderFailed('acme.bad', new Error('boom'));
    expect(m.listAll()[0]).toMatchObject({ status: 'failed', error: { code: 'RENDER_FAILED', message: 'boom' } });
    expect(events).toEqual(['load']);
  });

  it('已 failed / 未知 id → 无操作(不覆盖首个错误)', async () => {
    const m = await setup();
    m.markRenderFailed('acme.bad', new Error('first'));
    m.markRenderFailed('acme.bad', new Error('second'));
    m.markRenderFailed('nope', new Error('x'));
    expect(m.listAll()[0]?.error?.message).toBe('first');
  });

  it('之后「启用」重试:先停用旧实例再激活,恢复 enabled,不出双实例', async () => {
    const m = await setup();
    m.markRenderFailed('acme.bad', new Error('boom'));
    await m.enable('acme.bad');
    expect(events).toEqual(['load', 'unload', 'load']);
    expect(m.listAll()[0]).toMatchObject({ status: 'enabled' });
    expect(m.listAll()[0]?.error).toBeUndefined();
  });

  it('禁用仍可停掉仍在运行的实例', async () => {
    const m = await setup();
    m.markRenderFailed('acme.bad', new Error('boom'));
    await m.disable('acme.bad');
    expect(events).toEqual(['load', 'unload']);
    expect(m.listAll()[0]?.status).toBe('disabled');
  });
});

describe('启用后立即渲染出错(启用意图仍持久化,对齐 VSCode:视图出错不改变启用状态)', () => {
  /** 激活成功一置 enabled,订阅者(= React 重新渲染贡献)同步上报渲染出错 —— 模拟 enable 的 await 期间界面已渲染并抛错。 */
  function failRenderOnEnable(m: PluginManager): void {
    const off = m.subscribe(() => {
      if (m.listAll()[0]?.status !== 'enabled') return;
      off();
      m.markRenderFailed('acme.bad', new Error('boom'));
    });
  }

  async function setupDisabled() {
    events.length = 0;
    let enabled = new Set<string>();
    const host: ManagerHost = {
      listPluginDirs: () => [
        { id: 'acme.bad', manifestText: JSON.stringify({ id: 'acme.bad', name: 'Acme Bad', version: '1.0.0' }), moduleUrl: 'm' },
      ],
      readEnabledIds: () => enabled,
      mutateEnabledId: (id, on) => {
        enabled = new Set(enabled);
        if (on) enabled.add(id);
        else enabled.delete(id);
      },
      importModule: async () => ({ default: Tracked }),
    };
    const m = new PluginManager(createTestCoApp('1.0.0'), host);
    await m.init();
    return { m, host, enabledIds: () => enabled };
  }

  it('启用 → 渲染出错:启用意图已写入 _enabled.json;点「重载」后仍运行(enabled),重启后仍启用', async () => {
    const { m, host, enabledIds } = await setupDisabled();
    failRenderOnEnable(m);
    await m.enable('acme.bad');
    expect(m.listAll()[0]).toMatchObject({ status: 'failed', error: { code: 'RENDER_FAILED' } });
    expect(enabledIds().has('acme.bad')).toBe(true);

    await m.reload('acme.bad');
    expect(m.listAll()[0]?.status).toBe('enabled');
    expect(events).toEqual(['load', 'unload', 'load']);
    expect(enabledIds().has('acme.bad')).toBe(true);

    const restarted = new PluginManager(createTestCoApp('1.0.0'), host);
    await restarted.init();
    expect(restarted.listAll()[0]?.status).toBe('enabled');
  });

  it('别的窗口启用(广播)后本窗口渲染出错:重载仍重新激活(内存启用意图同样以激活成功为准)', async () => {
    const { m } = await setupDisabled();
    failRenderOnEnable(m);
    await m.handleEnabledChanged('acme.bad', true);
    expect(m.listAll()[0]?.status).toBe('failed');
    await m.reload('acme.bad');
    expect(m.listAll()[0]?.status).toBe('enabled');
  });
});
