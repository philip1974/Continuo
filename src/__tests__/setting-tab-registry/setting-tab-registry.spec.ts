import { describe, it, expect, vi } from 'vitest';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const noopRender = () => null;

describe('SettingTabRegistry', () => {
  it('register / dispose / getAll', () => {
    const r = new SettingTabRegistry();
    const d = r.register({ id: 'a', title: 'A', render: noopRender });
    expect(r.getAll().map((x) => x.id)).toEqual(['a']);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  // race(R55,R50-R54 同族):SettingsPanel 渲染前按 active id 从 live registry 复查,避免调
  // useRegistry 快照滞后期内已 unregister 的 tab 的 render。get(id) 提供该 live 查找。
  describe('get(id) live 查找(R55)', () => {
    it('register → get(id) 返回 spec;dispose 后返 undefined', () => {
      const r = new SettingTabRegistry();
      const d = r.register({ id: 'a', title: 'A', render: noopRender });
      expect(r.get('a')?.id).toBe('a');
      d.dispose();
      expect(r.get('a')).toBeUndefined();
    });

    it('已 dispose tab 的 render 不会经 live 查找被调(stale-skip 语义)', () => {
      const r = new SettingTabRegistry();
      const render = vi.fn(() => null);
      const d = r.register({ id: 'a', title: 'A', render });
      d.dispose();
      // 模拟 SettingsPanel 渲染:active 从 live registry 按 id 复查 → undefined → 回退/不调。
      const active = r.get('a') ?? r.getAll()[0] ?? null;
      if (active) active.render();
      expect(render).not.toHaveBeenCalled();
    });
  });

  it('priority 升序;缺失默认 100', () => {
    const r = new SettingTabRegistry();
    r.register({ id: 'def', title: 'D', render: noopRender });
    r.register({ id: 'top', title: 'T', render: noopRender, priority: 1 });
    r.register({ id: 'bot', title: 'B', render: noopRender, priority: 200 });
    expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def', 'bot']);
  });

  it('重复 getAll 复用排序结果,register/dispose 后失效重建', () => {
    const r = new SettingTabRegistry();
    const d = r.register({ id: 'def', title: 'D', render: noopRender });
    r.register({ id: 'top', title: 'T', render: noopRender, priority: 1 });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def']);
      expect(sortSpy).toHaveBeenCalledTimes(1);
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def']);
      expect(sortSpy).toHaveBeenCalledTimes(1);

      r.register({ id: 'bot', title: 'B', render: noopRender, priority: 200 });
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def', 'bot']);
      expect(sortSpy).toHaveBeenCalledTimes(2);

      d.dispose();
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'bot']);
      expect(sortSpy).toHaveBeenCalledTimes(3);
      expect(SettingTabRegistry.prototype.getAll.toString()).not.toContain(
        'items.push(',
      );
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单项快照不调用 sort', () => {
    const r = new SettingTabRegistry();
    r.register({ id: 'a', title: 'A', render: noopRender });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((x) => x.id)).toEqual(['a']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('重复 id → 后注册赢 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new SettingTabRegistry();
    r.register({ id: 'dup', title: 'A', render: noopRender });
    r.register({ id: 'dup', title: 'B', render: noopRender });
    expect(r.getAll()).toHaveLength(1);
    expect(r.getAll()[0]!.title).toBe('B');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('subscribe 在 register/dispose 触发', () => {
    const r = new SettingTabRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    const d = r.register({ id: 'a', title: 'A', render: noopRender });
    d.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // 边界(E40,E35/E36/E37 兄弟 registry):register 校验 id/title/titleKey 长度非空 + priority finite
  // + render 为函数。畸形 tab 成 active 时 SettingsPanel 调 render() 会崩整个面板(P1)。
  describe('E40 · 贡献项边界校验', () => {
    it('合法 spec → ok', () => {
      const r = new SettingTabRegistry();
      expect(() =>
        r.register({ id: 'a', title: 'A', render: noopRender }),
      ).not.toThrow();
    });

    it('超长 id/title/titleKey → 抛,不入 registry', () => {
      const r = new SettingTabRegistry();
      expect(() =>
        r.register({ id: 'x'.repeat(257), title: 'T', render: noopRender }),
      ).toThrow(/id exceeds max length/i);
      expect(() =>
        r.register({ id: 'a', title: 'T'.repeat(513), render: noopRender }),
      ).toThrow(/title exceeds max length/i);
      expect(() =>
        r.register({
          id: 'b',
          title: 'T',
          titleKey: 'k'.repeat(257),
          render: noopRender,
        }),
      ).toThrow(/titleKey exceeds max length/i);
      expect(r.getAll()).toEqual([]);
    });

    it('空 id/title → 抛', () => {
      const r = new SettingTabRegistry();
      expect(() =>
        r.register({ id: '', title: 'T', render: noopRender }),
      ).toThrow(/id must be a non-empty/i);
      expect(() =>
        r.register({ id: 'a', title: '', render: noopRender }),
      ).toThrow(/title must be a non-empty/i);
    });

    it('非有限 priority(NaN/Infinity)→ 抛', () => {
      const r = new SettingTabRegistry();
      expect(() =>
        r.register({ id: 'a', title: 'T', render: noopRender, priority: NaN }),
      ).toThrow(/priority must be finite/i);
      expect(() =>
        r.register({
          id: 'b',
          title: 'T',
          render: noopRender,
          priority: Infinity,
        }),
      ).toThrow(/priority must be finite/i);
    });

    it('render 非函数 → 抛(防 SettingsPanel 渲染崩)', () => {
      const r = new SettingTabRegistry();
      expect(() =>
        r.register({ id: 'a', title: 'T', render: 'nope' as never }),
      ).toThrow(/render must be a function/i);
    });

    // 边界(E155,E153/E154 兄弟):可选 titleKey 此前只有 length 上限无 typeof(titleKey:123 经
    // `(123).length === undefined > max` 为 false 绕过)→ 补 typeof 守卫。
    it('E155 titleKey 非字符串 → 抛', () => {
      const r = new SettingTabRegistry();
      expect(() =>
        r.register({
          id: 'a',
          title: 'T',
          render: noopRender,
          titleKey: 123 as never,
        }),
      ).toThrow(/titleKey must be a string/i);
    });
  });
});

describe('Plugin.addSettingTab 集成', () => {
  const manifest: PluginManifest = {
    id: 'test.set',
    name: 'Set',
    version: '0.1.0',
  };

  it('addSettingTab 注册 + _deactivate 自动移除', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {
        this.addSettingTab({
          id: 'mine',
          title: 'Mine',
          render: noopRender,
        });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.settingTabs.getAll().map((x) => x.id)).toEqual(['mine']);
    await p._deactivate();
    expect(app.settingTabs.getAll()).toEqual([]);
  });
});
