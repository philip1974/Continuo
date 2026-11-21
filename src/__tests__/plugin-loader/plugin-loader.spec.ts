// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Plugin } from '../../plugins/Plugin';
import { loadPluginModule } from '../../plugins/loader';

beforeEach(() => {
  document.head.querySelectorAll('style[data-plugin-id]').forEach((el) =>
    el.remove(),
  );
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
