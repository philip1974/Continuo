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

  // 边界(E101,E97/E100 id 前门一致性):manifest.id 非法/超长 → 回退目录名(不把非法 id 当
  // mtimes key + 广播到 renderer)。
  it('E101 manifest.id 超长(>256)→ 回退目录名作 pluginId', async () => {
    makeDir('mydir', { id: 'x'.repeat(300), name: 'Foo', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    touch('mydir', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('mydir'); // 回退目录名,不用非法超长 id
  });

  it('E101 manifest.id 路径穿越(..)→ 回退目录名', async () => {
    makeDir('mydir2', { id: '..', name: 'Foo', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    touch('mydir2', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('mydir2');
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

  // race(R5):并发 tick(扫描慢于 interval 时 setInterval 重入)必须单飞 —— 同一变更只 fire 一次,
  // 不因两个并发扫描各自读到旧 mtime 而重复 onChange。
  it('R5 并发 tick:同一 mtime 变更只 fire 一次(单飞防重入)', async () => {
    makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick(); // 填表(firstRun→false)
    touch('a', 'main.js', Date.now() + 5000); // mtime 跳变

    // 并发触发两个 tick(不在中间 await):单飞包装下第二个置 pending、不并发扫描。
    await Promise.all([w.tick(), w.tick()]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  // race(R67-B):onChange(广播)抛错不应阻止 mtimes 推进 —— 否则同一变更每 tick 反复触发。
  // 顺序改为先 mtimes.set 再 onChange:检测确认即记录,通知成败不回灌脏状态。
  it('R67 onChange 抛错 → mtime 仍推进,下一 tick 不重复触发同一变更', async () => {
    makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
    const fn = vi.fn(() => {
      throw new Error('broadcast send failed'); // 模拟广播 send 抛错
    });
    const w = createPluginsWatcher(tmp, fn);
    await w.tick(); // 填表
    touch('a', 'main.js', Date.now() + 5000); // mtime 跳变
    // onChange 抛错:tick 内被 per-entry catch 吞掉,不冒泡。
    await expect(w.tick()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);

    // 关键:mtime 已推进,下一 tick(无新变更)不再重复触发同一变更。
    await w.tick();
    expect(fn).toHaveBeenCalledTimes(1);
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
