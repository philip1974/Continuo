// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Plugin } from '../../plugins/Plugin';
import { injectStyles, loadPluginModule } from '../../plugins/loader';

beforeEach(() => {
  document.head.querySelectorAll('style[data-plugin-id]').forEach((el) =>
    el.remove(),
  );
});

// ── injectStyles ─────────────────────────────────────────

describe('injectStyles', () => {
  it('插入带 data-plugin-id 的 <style>,内容正确', () => {
    injectStyles('.foo{color:red}', 'com.test.a');
    const el = document.head.querySelector(
      'style[data-plugin-id="com.test.a"]',
    );
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('.foo{color:red}');
  });

  it('Disposable.dispose() 移除 <style>', () => {
    const d = injectStyles('.x{}', 'com.test.b');
    expect(
      document.head.querySelector('style[data-plugin-id="com.test.b"]'),
    ).not.toBeNull();
    d.dispose();
    expect(
      document.head.querySelector('style[data-plugin-id="com.test.b"]'),
    ).toBeNull();
  });

  it('同 scopeId 重复注入 → 旧的被替换(不累积)', () => {
    injectStyles('.a{}', 'com.test.dup');
    injectStyles('.b{}', 'com.test.dup');
    const els = document.head.querySelectorAll(
      'style[data-plugin-id="com.test.dup"]',
    );
    expect(els.length).toBe(1);
    expect(els[0]!.textContent).toBe('.b{}');
  });

  it('dispose 二次调用幂等', () => {
    const d = injectStyles('.a{}', 'com.test.idem');
    d.dispose();
    expect(() => d.dispose()).not.toThrow();
  });
});

// ── loadPluginModule ────────────────────────────────────

describe('loadPluginModule', () => {
  const baseManifest = {
    id: 'com.test.x',
    name: 'X',
    version: '0.1.0',
  };

  it('module.default 是 Plugin 子类 → ok', async () => {
    class Foo extends Plugin {
      onload() {}
    }
    const importer = vi.fn().mockResolvedValue({ default: Foo });
    const r = await loadPluginModule({
      moduleUrl: 'fake://x',
      manifest: baseManifest,
      importer,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.PluginClass).toBe(Foo);
    expect(importer).toHaveBeenCalledWith('fake://x');
  });

  it('module 无 default → NO_DEFAULT_EXPORT', async () => {
    const importer = vi.fn().mockResolvedValue({ named: 1 });
    const r = await loadPluginModule({
      moduleUrl: 'fake://x',
      manifest: baseManifest,
      importer,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_DEFAULT_EXPORT');
  });

  it('default 不是 class(普通函数 / 对象)→ NOT_PLUGIN_CLASS', async () => {
    const importer = vi.fn().mockResolvedValue({ default: { foo: 1 } });
    const r = await loadPluginModule({
      moduleUrl: 'fake://x',
      manifest: baseManifest,
      importer,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_PLUGIN_CLASS');
  });

  it('default 是普通函数(非 Plugin 子类)→ NOT_PLUGIN_CLASS', async () => {
    function NotPlugin() {}
    const importer = vi.fn().mockResolvedValue({ default: NotPlugin });
    const r = await loadPluginModule({
      moduleUrl: 'fake://x',
      manifest: baseManifest,
      importer,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_PLUGIN_CLASS');
  });

  it('importer 抛错 → IMPORT_FAILED 含 message', async () => {
    const importer = vi.fn().mockRejectedValue(new Error('network'));
    const r = await loadPluginModule({
      moduleUrl: 'fake://x',
      manifest: baseManifest,
      importer,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('IMPORT_FAILED');
      expect(r.message).toContain('network');
    }
  });
});
