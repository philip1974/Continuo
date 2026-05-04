import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginsWatcher } from '../../../electron/main/services/plugins.service';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lm-watch-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDir(dirName: string, manifest: object, mainText = '/* main */') {
  const dir = join(tmp, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'main.js'), mainText);
}

function touch(dirName: string, file = 'main.js', mtimeMs = Date.now()) {
  const t = mtimeMs / 1000;
  utimesSync(join(tmp, dirName, file), t, t);
}

describe('createPluginsWatcher', () => {
  it('首次 tick 只填表不 fire', async () => {
    makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    expect(fn).not.toHaveBeenCalled();
  });

  it('mtime 变化 → fire(用 manifest.id 不用目录名)', async () => {
    makeDir('mydir', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick(); // 填表
    touch('mydir', 'main.js', Date.now() + 5000); // 模拟 mtime 跳
    await w.tick();
    expect(fn).toHaveBeenCalledWith('com.foo');
  });

  it('mtime 没变 → 不 fire', async () => {
    makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    await w.tick();
    expect(fn).not.toHaveBeenCalled();
  });

  it('baseDir 不存在 → tick 静默不抛', async () => {
    const w = createPluginsWatcher(join(tmp, 'nope'), vi.fn());
    await expect(w.tick()).resolves.toBeUndefined();
  });

  it('单 plugin manifest 解析失败 → 跳过,其它继续', async () => {
    makeDir('good', { id: 'good', name: 'G', version: '0.1.0' });
    const badDir = join(tmp, 'bad');
    mkdirSync(badDir);
    writeFileSync(join(badDir, 'manifest.json'), 'not json');
    writeFileSync(join(badDir, 'main.js'), '/* */');

    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    touch('good', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('good');
    expect(fn).not.toHaveBeenCalledWith('bad');
  });

  it('manifest.main 自定义入口的 mtime 也被监控', async () => {
    const dir = join(tmp, 'cust');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'cust',
        name: 'X',
        version: '0.1.0',
        main: 'index.js',
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'X');
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    touch('cust', 'index.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('cust');
  });

  it('忽略 . / _ 开头目录(不报告假阳性)', async () => {
    makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
    mkdirSync(join(tmp, '_hidden'));
    writeFileSync(join(tmp, '_hidden', 'main.js'), 'x');
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    await w.tick();
    expect(fn).not.toHaveBeenCalled();
  });

  it('start(intervalMs) 返 dispose,disposed 后 tick 不再 fire', async () => {
    makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    const handle = w.start(10000); // 大 interval 避免本测被 timer 干扰
    handle.dispose();
    touch('a', 'main.js', Date.now() + 5000);
    await w.tick();
    // tick 内 cancelled 检查应阻止 fire
    expect(fn).not.toHaveBeenCalled();
  });
});
