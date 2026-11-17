import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  statSync,
  renameSync,
  promises as fsp,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginsWatcher } from '../../../electron/main/services/plugins.service';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lm-watch-'));
});
afterEach(() => {
  vi.restoreAllMocks();
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

  // perf:manifest 未变(ino/size/mtime/ctime 相同)→ 不再每轮读取 + JSON.parse,main 变化照常检测。
  it('manifest 未变 → 后续 tick 不再读 manifest,main mtime 变化仍 fire', async () => {
    makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    const opened: string[] = [];
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((...args: Parameters<typeof fsp.open>) => {
      opened.push(String(args[0]));
      return realOpen(...args);
    });
    await w.tick();
    touch('a', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(opened.filter((p) => p.endsWith('manifest.json'))).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('manifest 原地改写(mtime 被还原、大小不变)→ 仍重新解析,跟随新 main 入口', async () => {
    const dir = join(tmp, 'c');
    mkdirSync(dir);
    const mf = (main: string) => JSON.stringify({ id: 'c', name: 'C', version: '0.1.0', main });
    writeFileSync(join(dir, 'manifest.json'), mf('a.js'));
    writeFileSync(join(dir, 'a.js'), 'A');
    writeFileSync(join(dir, 'b.js'), 'B');
    const fixed = Math.floor(Date.now() / 1000) - 100; // 整秒:还原后 mtimeMs 精确相等
    utimesSync(join(dir, 'manifest.json'), fixed, fixed);
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    const before = statSync(join(dir, 'manifest.json'));
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, 'manifest.json'), mf('b.js')); // 同长度
    utimesSync(join(dir, 'manifest.json'), fixed, fixed); // 还原 mtime,仅 ctime 变
    const after = statSync(join(dir, 'manifest.json'));
    expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
    touch('c', 'b.js', Date.now() + 5000);
    await w.tick(); // 切到 b.js:prev(a.js 的 mtime) ≠ b.js mtime → fire
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('manifest 原子替换(rename)换 id → 用新 id 报告变化', async () => {
    makeDir('d', { id: 'old.id', name: 'D', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    writeFileSync(join(tmp, 'd', 'manifest.tmp'), JSON.stringify({ id: 'new.id', name: 'D', version: '0.1.0' }));
    renameSync(join(tmp, 'd', 'manifest.tmp'), join(tmp, 'd', 'manifest.json'));
    await w.tick(); // 已监控目录改声明 new.id → 视为 new.id 变化(激活快照令牌失效后需重新加载)
    expect(fn.mock.calls).toEqual([['new.id']]);
    touch('d', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn.mock.calls).toEqual([['new.id'], ['new.id']]);
    expect(fn).not.toHaveBeenCalledWith('old.id');
  });

  // P1 配套:激活时 manifest 令牌不一致 → 插件激活失败;须由 watcher 广播让 renderer 重新加载。
  // 此前 watcher 只看 main mtime,只改 manifest(权限 / 版本)不广播 → 失败状态不会自动纠正。
  it('只改 manifest 内容(main 不变)→ fire 一次;只 touch manifest(内容不变)→ 不 fire', async () => {
    makeDir('m', { id: 'm', name: 'M', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    touch('m', 'manifest.json', Date.now() + 5000);
    await w.tick();
    expect(fn).not.toHaveBeenCalled();
    writeFileSync(
      join(tmp, 'm', 'manifest.json'),
      JSON.stringify({ id: 'm', name: 'M', version: '0.2.0', permissions: ['shell'] }),
    );
    await w.tick();
    await w.tick();
    expect(fn.mock.calls).toEqual([['m']]);
  });

  it('manifest 删除后重建 → 期间跳过,重建后继续检测', async () => {
    makeDir('e', { id: 'e', name: 'E', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    rmSync(join(tmp, 'e', 'manifest.json'));
    touch('e', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).not.toHaveBeenCalled();
    writeFileSync(join(tmp, 'e', 'manifest.json'), JSON.stringify({ id: 'e', name: 'E', version: '0.1.0' }));
    await w.tick(); // mtimes 里 e 仍是删除前的值 → 本轮检测到 main 已变
    expect(fn).toHaveBeenCalledWith('e');
  });

  it('per-dir stat 有界并发(>1 且 ≤8)', async () => {
    for (let i = 0; i < 20; i += 1) makeDir(`p${i}`, { id: `p${i}`, name: 'P', version: '0.1.0' });
    const realStat = fsp.stat.bind(fsp);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(fsp, 'stat').mockImplementation((async (...args: Parameters<typeof fsp.stat>) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await realStat(...args);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fsp.stat);
    const w = createPluginsWatcher(tmp, vi.fn());
    await w.tick();
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  // 重复 manifest.id:每个 id 只看唯一权威目录(目录名 == id 优先,否则目录名字典序最小,与
  // PluginManager.preferPluginDir / readPluginDirByManifestId 同规则)。此前 mtimes 以 id 为键,
  // 两个目录轮流写入同一键 → 每轮都判定变化并广播,形成永久重载风暴。
  describe('重复 manifest.id', () => {
    const now = Date.now();
    function dupDirs(): void {
      makeDir('b.dir', { id: 'x.id', name: 'B', version: '0.1.0' });
      makeDir('a.dir', { id: 'x.id', name: 'A', version: '0.1.0' });
      touch('a.dir', 'main.js', now - 50_000);
      touch('b.dir', 'main.js', now - 90_000);
    }

    it('两目录 mtime 不同但均未变化 → 多轮扫描都不 fire', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      for (let i = 0; i < 4; i += 1) await w.tick();
      expect(fn).not.toHaveBeenCalled();
    });

    it('权威目录(字典序最小)main 变化 → fire 一次;非权威目录变化 → 不 fire', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      touch('b.dir', 'main.js', now + 5000); // 非权威
      await w.tick();
      await w.tick();
      expect(fn).not.toHaveBeenCalled();
      touch('a.dir', 'main.js', now + 9000); // 权威
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id']]);
    });

    it('出现目录名 == id 的目录 → 权威目录切换,fire 一次后稳定', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      makeDir('x.id', { id: 'x.id', name: 'X', version: '0.1.0' });
      touch('x.id', 'main.js', now - 70_000);
      await w.tick();
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id']]);
    });

    // 权威目录选择须与列举(isPluginMainAvailable:main 为普通文件且 ≤8MiB)同口径:否则 watcher 盯住
    // 无效首选目录,PluginManager 实际运行的后备目录被修改时不再热重载。
    it.each([
      ['main 是目录', (dir: string) => {
        rmSync(join(tmp, dir, 'main.js'));
        mkdirSync(join(tmp, dir, 'main.js'));
      }],
      ['main 超 8MiB', (dir: string) => fsp.truncate(join(tmp, dir, 'main.js'), 8 * 1024 * 1024 + 1)],
    ])('首选目录无效(%s)→ 以合法后备目录为权威,后备目录 main 变化 fire', async (_label, breakMain) => {
      dupDirs();
      await breakMain('a.dir');
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      touch('b.dir', 'main.js', now + 5000);
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id']]);
    });

    it('权威目录被删除 → 回落到剩余目录并 fire 一次', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      rmSync(join(tmp, 'a.dir'), { recursive: true, force: true });
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id']]);
    });
  });

  // 清理只针对「记录所属目录现在声明了别的 id」的陈旧键;目录暂时消失(rm -rf 后重新部署)时保留记录,
  // 重建后 main 变化仍能触发热重载(与「manifest 删除后重建」同口径)。
  it('目录被删除后重建(main 已变)→ 仍 fire', async () => {
    makeDir('g', { id: 'g', name: 'G', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    rmSync(join(tmp, 'g'), { recursive: true, force: true });
    await w.tick();
    expect(fn).not.toHaveBeenCalled();
    makeDir('g', { id: 'g', name: 'G', version: '0.1.0' });
    touch('g', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('g');
  });

  it('目录改声明新 id 后,旧 id 的记录被清理:每次改 id 各 fire 一次新 id,之后 main 变化只报当前 id', async () => {
    makeDir('h', { id: 'h.old', name: 'H', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    const swap = (id: string): void => {
      writeFileSync(join(tmp, 'h', 'manifest.tmp'), JSON.stringify({ id, name: 'H', version: '0.1.0' }));
      renameSync(join(tmp, 'h', 'manifest.tmp'), join(tmp, 'h', 'manifest.json'));
    };
    swap('h.new');
    await w.tick();
    expect(fn.mock.calls).toEqual([['h.new']]);
    swap('h.old');
    await w.tick(); // 目录又改回 h.old → 视为 h.old 变化
    expect(fn.mock.calls).toEqual([['h.new'], ['h.old']]);
    touch('h', 'main.js', Date.now() + 5000);
    await w.tick();
    await w.tick();
    expect(fn.mock.calls).toEqual([['h.new'], ['h.old'], ['h.old']]); // h.new 记录已清理,不再被报告
  });

  // 缺失记录(目录 / manifest / main 暂时不可见)不限时保留:rm -rf 后部署/构建/网络卷恢复耗时再久,重建后仍 fire。
  // 只按容量淘汰(记录总数超上限时淘汰最早缺失的),防永久删除的历史 id 无界累积。
  it('目录长时间缺失(远超 5 轮)后重建(main 已变)→ 仍 fire', async () => {
    makeDir('u', { id: 'u', name: 'U', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    rmSync(join(tmp, 'u'), { recursive: true, force: true });
    for (let i = 0; i < 50; i += 1) await w.tick();
    makeDir('u', { id: 'u', name: 'U', version: '0.1.0' });
    touch('u', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn.mock.calls).toEqual([['u']]);
  });

  it('缺失记录数有上界:超过容量时淘汰最早缺失的记录,较新的缺失记录保留', async () => {
    for (const id of ['m1', 'm2', 'm3']) makeDir(id, { id, name: 'M', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn, { missingRecordCap: 2 });
    await w.tick();
    // 依次删除:m1 最早缺失,m3 最晚
    for (const id of ['m1', 'm2', 'm3']) {
      rmSync(join(tmp, id), { recursive: true, force: true });
      await w.tick();
    }
    for (const id of ['m1', 'm2', 'm3']) {
      makeDir(id, { id, name: 'M', version: '0.1.0' });
      touch(id, 'main.js', Date.now() + 5000);
    }
    await w.tick();
    // m1 记录已被淘汰 → 视为首次出现不 fire;m2/m3 仍在容量内 → fire
    expect(fn.mock.calls).toEqual([['m2'], ['m3']]);
  });

  it('缺失记录所属目录重建后改声明别的 id → 该缺失记录被清理(之后旧 id 出现在新目录视为首次出现)', async () => {
    makeDir('d', { id: 'old.id', name: 'D', version: '0.1.0' });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    rmSync(join(tmp, 'd'), { recursive: true, force: true });
    await w.tick(); // old.id 转为缺失记录
    makeDir('d', { id: 'new.id', name: 'D', version: '0.1.0' });
    await w.tick(); // 目录 d 改声明 new.id:fire new.id,old.id 缺失记录陈旧 → 清理
    makeDir('e', { id: 'old.id', name: 'E', version: '0.1.0' });
    await w.tick();
    expect(fn.mock.calls).toEqual([['new.id']]);
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
