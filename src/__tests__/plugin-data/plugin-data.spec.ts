import { describe, it, expect, vi } from 'vitest';
import { Plugin } from '../../plugins/Plugin';
import { InMemoryDataStore } from '../../plugins/PluginDataStore';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const manifest: PluginManifest = {
  id: 'test.data',
  name: 'Data',
  version: '0.1.0',
};

describe('InMemoryDataStore', () => {
  it('read 未写过的 id → null', async () => {
    const ds = new InMemoryDataStore();
    expect(await ds.read('foo')).toBeNull();
  });

  it('write + read 往返', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('foo', { x: 1 });
    expect(await ds.read('foo')).toEqual({ x: 1 });
  });

  it('write 不同 id 互不干扰', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('a', 1);
    await ds.write('b', 2);
    expect(await ds.read('a')).toBe(1);
    expect(await ds.read('b')).toBe(2);
  });

  it('write 同 id 覆盖', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('k', 'v1');
    await ds.write('k', 'v2');
    expect(await ds.read('k')).toBe('v2');
  });
});

describe('Plugin.loadData / saveData', () => {
  it('saveData → dataStore.write,loadData → dataStore.read', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {}
      async testSave(d: unknown) {
        await this.saveData(d);
      }
      async testLoad<T>(): Promise<T | null> {
        return this.loadData<T>();
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    await p.testSave({ pref: 'dark' });
    const got = await p.testLoad<{ pref: string }>();
    expect(got).toEqual({ pref: 'dark' });
  });

  it('loadData 未写过 → null', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {}
      async testLoad<T>(): Promise<T | null> {
        return this.loadData<T>();
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(await p.testLoad()).toBeNull();
  });

  it('dataStore.read 抛错 → loadData 返 null + warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    app.dataStore.read = () => Promise.reject(new Error('IO fail'));
    class P extends Plugin {
      onload() {}
      async testLoad() {
        return this.loadData();
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(await p.testLoad()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('saveData 抛错向上传(不吞)', async () => {
    const app = createTestApp();
    app.dataStore.write = () => Promise.reject(new Error('disk full'));
    class P extends Plugin {
      onload() {}
      async testSave(d: unknown) {
        await this.saveData(d);
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    await expect(p.testSave({ x: 1 })).rejects.toThrow('disk full');
  });
});
