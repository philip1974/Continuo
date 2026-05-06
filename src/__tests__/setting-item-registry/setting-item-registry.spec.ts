import { describe, it, expect, vi } from 'vitest';
import { SettingItemRegistry } from '../../plugins/registries/SettingItemRegistry';

describe('SettingItemRegistry', () => {
  it('register / dispose / getAll', () => {
    const r = new SettingItemRegistry();
    const d = r.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
    });
    expect(r.getAll().map((x) => x.id)).toEqual(['general.theme']);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  it('getByCategory 过滤 + 排序', () => {
    const r = new SettingItemRegistry();
    r.register({
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
      priority: 10,
    });
    r.register({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      type: 'select',
      default: 'dark',
      priority: 1,
    });
    r.register({
      id: 'editor.lineNumbers',
      category: 'editor',
      title: '行号',
      type: 'boolean',
      default: true,
      priority: 5,
    });
    expect(r.getByCategory('editor').map((s) => s.id)).toEqual([
      'editor.lineNumbers',
      'editor.fontSize',
    ]);
    expect(r.getByCategory('general').map((s) => s.id)).toEqual([
      'general.theme',
    ]);
    expect(r.getByCategory('nope')).toEqual([]);
  });

  it('priority 升序;缺失默认 100', () => {
    const r = new SettingItemRegistry();
    r.register({
      id: 'mid',
      category: 'g',
      title: 'M',
      type: 'boolean',
      default: false,
    });
    r.register({
      id: 'top',
      category: 'g',
      title: 'T',
      type: 'boolean',
      default: false,
      priority: 1,
    });
    r.register({
      id: 'bot',
      category: 'g',
      title: 'B',
      type: 'boolean',
      default: false,
      priority: 200,
    });
    expect(r.getAll().map((s) => s.id)).toEqual(['top', 'mid', 'bot']);
  });

  it('重复 id → 后注册赢 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new SettingItemRegistry();
    r.register({
      id: 'dup',
      category: 'g',
      title: 'A',
      type: 'boolean',
      default: false,
    });
    r.register({
      id: 'dup',
      category: 'g',
      title: 'B',
      type: 'boolean',
      default: true,
    });
    expect(warn).toHaveBeenCalled();
    expect(r.getAll()).toHaveLength(1);
    expect(r.getAll()[0]?.title).toBe('B');
    warn.mockRestore();
  });

  it('subscribe 通知 register/dispose;dispose 后不再触发', () => {
    const r = new SettingItemRegistry();
    const cb = vi.fn();
    const unsub = r.subscribe(cb);
    const d = r.register({
      id: 'a',
      category: 'g',
      title: 'A',
      type: 'boolean',
      default: false,
    });
    expect(cb).toHaveBeenCalledTimes(1);
    d.dispose();
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    r.register({
      id: 'b',
      category: 'g',
      title: 'B',
      type: 'boolean',
      default: false,
    });
    expect(cb).toHaveBeenCalledTimes(2); // unsubscribed
  });

  it('dispose 幂等', () => {
    const r = new SettingItemRegistry();
    const d = r.register({
      id: 'a',
      category: 'g',
      title: 'A',
      type: 'boolean',
      default: false,
    });
    d.dispose();
    d.dispose(); // 不抛
    expect(r.getAll()).toEqual([]);
  });
});
