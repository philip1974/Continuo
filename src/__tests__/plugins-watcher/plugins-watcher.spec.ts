import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  statSync,
  renameSync,
  symlinkSync,
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

  // perf:超大 manifest 不会自己变小 —— 按 stat 签名缓存「跳过」,签名不变不再每轮 open+fstat + 打告警
  //(2s 轮询下每天数万条);签名变化(被改小)照常重读。
  it('manifest 超 1MiB → 跳过且只告警一次;签名不变的后续 tick 不再 open;改小后重新解析', async () => {
    makeDir('big', { id: 'big', name: 'B', version: '0.1.0' });
    writeFileSync(
      join(tmp, 'big', 'manifest.json'),
      JSON.stringify({ id: 'big', name: 'B', version: '0.1.0', pad: 'x'.repeat(1024 * 1024) }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opened: string[] = [];
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((...args: Parameters<typeof fsp.open>) => {
      opened.push(String(args[0]));
      return realOpen(...args);
    });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    await w.tick();
    await w.tick();
    expect(opened.filter((p) => p.endsWith('manifest.json'))).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('超大文件'))).toHaveLength(1);

    writeFileSync(join(tmp, 'big', 'manifest.json'), JSON.stringify({ id: 'big', name: 'B', version: '0.1.0' }));
    await w.tick(); // 签名变化 → 重读,纳入监控
    touch('big', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('big');
  });

  it('manifest 读失败(无读权限)→ 不缓存,每轮重试;恢复权限后纳入监控', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod 语义 / root 无视权限
    makeDir('locked', { id: 'locked', name: 'L', version: '0.1.0' });
    const manifestPath = join(tmp, 'locked', 'manifest.json');
    await fsp.chmod(manifestPath, 0o000);
    const opened: string[] = [];
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((...args: Parameters<typeof fsp.open>) => {
      opened.push(String(args[0]));
      return realOpen(...args);
    });
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    await w.tick();
    expect(opened.filter((p) => p.endsWith('manifest.json'))).toHaveLength(2);
    await fsp.chmod(manifestPath, 0o644); // chmod 改 ctime → 签名变化;读失败本就未缓存
    await w.tick();
    touch('locked', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('locked');
  });

  it('插件目录条目达上限 → 截断告警每个 watcher 只在进入截断状态时打一次', async () => {
    for (let i = 0; i < 1025; i += 1) writeFileSync(join(tmp, `f${i}`), '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const truncWarns = () => warn.mock.calls.filter((c) => String(c[0]).includes('目录条目截断')).length;
    const w = createPluginsWatcher(tmp, vi.fn());
    await w.tick();
    await w.tick();
    await w.tick();
    expect(truncWarns()).toBe(1);
    // 降到上限以下再超回去:截断状态变化 → 再告警一次
    for (let i = 0; i < 10; i += 1) rmSync(join(tmp, `f${i}`));
    await w.tick();
    for (let i = 0; i < 10; i += 1) writeFileSync(join(tmp, `f${i}`), '');
    await w.tick();
    await w.tick();
    expect(truncWarns()).toBe(2);
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

  // perf:枚举得到的 Dirent 已知是目录 → 不再为每个目录每轮额外 stat;symlink / 类型未知才回退 stat。
  it('普通目录不做 directory stat;指向目录的 symlink 回退 stat 仍被监控', async () => {
    makeDir('real', { id: 'real', name: 'R', version: '0.1.0' });
    const target = mkdtempSync(join(tmpdir(), 'lm-watch-link-'));
    try {
      mkdirSync(join(target, 'pkg'));
      writeFileSync(join(target, 'pkg', 'manifest.json'), JSON.stringify({ id: 'lnk', name: 'L', version: '0.1.0' }));
      writeFileSync(join(target, 'pkg', 'main.js'), '/* main */');
      symlinkSync(join(target, 'pkg'), join(tmp, 'lnk'), 'dir');
      const realStat = fsp.stat.bind(fsp);
      const statted: string[] = [];
      vi.spyOn(fsp, 'stat').mockImplementation(((p: Parameters<typeof fsp.stat>[0], ...rest: unknown[]) => {
        statted.push(String(p));
        return (realStat as (...a: unknown[]) => ReturnType<typeof fsp.stat>)(p, ...rest);
      }) as typeof fsp.stat);
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      expect(statted).not.toContain(join(tmp, 'real'));
      expect(statted).toContain(join(tmp, 'lnk'));
      touch('real', 'main.js', Date.now() + 5000);
      utimesSync(join(target, 'pkg', 'main.js'), Date.now() / 1000 + 5, Date.now() / 1000 + 5);
      await w.tick();
      // 回调顺序随目录枚举顺序(各平台/文件系统不同),只比集合。
      expect([...fn.mock.calls].sort()).toEqual([['lnk'], ['real']]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // 重复 manifest.id:watcher 只决定是否广播,不选目录(选目录由 renderer PluginManager.selectPluginDirs 统一做,
  // 它还要看 manifest schema 与 minLMVersion,main 判断不了)。每个 id 记一份「全部声明它的目录」的合并签名:
  // 任一目录变化都广播一次。此前 mtimes 以 id 为键、两个目录轮流写入同一键 → 每轮都判定变化,形成永久重载风暴;
  // 后来只看一个「权威目录」又会漏掉 renderer 实际在用的另一个目录的变化。
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

    it('任一声明该 id 的目录 main / manifest 变化 → 各 fire 一次(renderer 实际在用哪个目录由它自己选)', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      touch('b.dir', 'main.js', now + 5000);
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id']]);
      touch('a.dir', 'main.js', now + 9000);
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id'], ['x.id']]);
      writeFileSync(join(tmp, 'b.dir', 'manifest.json'), JSON.stringify({ id: 'x.id', name: 'B2', version: '0.2.0' }));
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id'], ['x.id'], ['x.id']]);
    });

    it('新增一个声明该 id 的目录 → fire 一次后稳定', async () => {
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

    // 候选口径与列举(isPluginMainAvailable:main 为普通文件且 ≤8MiB)一致:无效目录不进签名,合法后备目录的变化照常 fire。
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

    // 记账覆盖全部候选目录(不只是字典序最小的那个):renderer 实际在用哪个目录由它自己选。
    it('非字典序最小的候选目录改声明新 id → 新 id fire 一次', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      writeFileSync(join(tmp, 'b.dir', 'manifest.json'), JSON.stringify({ id: 'y.id', name: 'Y', version: '0.1.0' }));
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id'], ['y.id']]);
    });

    it('tombstone 的非字典序最小候选目录改声明新 id → 新 id fire 一次', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      rmSync(join(tmp, 'a.dir', 'main.js'));
      rmSync(join(tmp, 'b.dir', 'main.js'));
      await w.tick(); // x.id 转 tombstone(候选 a.dir、b.dir)
      expect(fn).not.toHaveBeenCalled();
      writeFileSync(join(tmp, 'b.dir', 'manifest.json'), JSON.stringify({ id: 'y.id', name: 'Y', version: '0.1.0' }));
      writeFileSync(join(tmp, 'b.dir', 'main.js'), '');
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['y.id']]);
    });

    it('代表目录改声明别的 id、同时另一候选 main 暂时缺失 → 记录转 tombstone,main 恢复后 fire', async () => {
      dupDirs();
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      writeFileSync(join(tmp, 'a.dir', 'manifest.json'), JSON.stringify({ id: 'z.id', name: 'Z', version: '0.1.0' }));
      rmSync(join(tmp, 'b.dir', 'main.js'));
      await w.tick();
      fn.mockClear();
      writeFileSync(join(tmp, 'b.dir', 'main.js'), 'changed');
      touch('b.dir', 'main.js', now + 7000);
      await w.tick();
      await w.tick();
      expect(fn.mock.calls).toEqual([['x.id']]);
    });

    it('某候选目录被删除 → fire 一次后稳定', async () => {
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
    // m1 记录已被淘汰 → 视为首次出现不 fire;m2/m3 仍在容量内 → fire。
    // 同一次 tick 里多个目录的回调顺序跟随目录枚举顺序(Linux 上不固定),只比集合。
    expect([...fn.mock.calls].sort()).toEqual([['m2'], ['m3']]);
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

  // 安全:旧安装的插件目录可能带符号链接。watcher 读 manifest(算 hash、取 id)前与列举同口径校验
  // 真实路径仍在插件目录内,否则等于替插件读目录外文件。
  it('manifest.json 是指向插件目录外文件的符号链接 → 跳过该目录,不读外部文件(不以其 id 报告变化)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'lm-watch-outside-'));
    try {
      writeFileSync(join(outside, 'secret.json'), JSON.stringify({ id: 'outside.id', name: 'X', version: '1' }));
      const dir = join(tmp, 'evil');
      mkdirSync(dir);
      symlinkSync(join(outside, 'secret.json'), join(dir, 'manifest.json'));
      writeFileSync(join(dir, 'main.js'), '/* main */');
      const open = vi.spyOn(fsp, 'open');
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.tick();
      touch('evil', 'main.js', Date.now() + 5000);
      await w.tick();
      expect(fn).not.toHaveBeenCalled();
      expect(open.mock.calls.filter((c) => String(c[0]).endsWith('manifest.json'))).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('manifest.json 是指向插件目录内文件的符号链接 → 照常监控', async () => {
    const dir = join(tmp, 'linked');
    mkdirSync(dir);
    writeFileSync(join(dir, 'real-manifest.json'), JSON.stringify({ id: 'linked.id', name: 'L', version: '1' }));
    symlinkSync(join(dir, 'real-manifest.json'), join(dir, 'manifest.json'));
    writeFileSync(join(dir, 'main.js'), '/* main */');
    const fn = vi.fn();
    const w = createPluginsWatcher(tmp, fn);
    await w.tick();
    touch('linked', 'main.js', Date.now() + 5000);
    await w.tick();
    expect(fn).toHaveBeenCalledWith('linked.id');
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

  // 冷启动性能:生产 start 不再立即首扫(与启动 IO 争 libuv 线程池);基线由 ensureBaseline 按需建立
  //(LIST_DIRS 列举前),保证「列举之后的修改」一定被下一轮 tick 发现。
  describe('延后首扫 + ensureBaseline', () => {
    it('start(interval, { immediate:false }) 不立即扫描;此后首个 tick 仍只填表', async () => {
      makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
      const fn = vi.fn();
      const readdir = vi.spyOn(fsp, 'readdir');
      const opendir = vi.spyOn(fsp, 'opendir');
      const w = createPluginsWatcher(tmp, fn);
      const handle = w.start(100000, { immediate: false });
      await new Promise((r) => setTimeout(r, 20));
      expect(readdir.mock.calls.length + opendir.mock.calls.length).toBe(0);
      touch('a', 'main.js', Date.now() + 5000);
      await w.tick(); // 首扫 = 基线,不 fire
      expect(fn).not.toHaveBeenCalled();
      handle.dispose();
    });

    it('基线未建立时 ensureBaseline 先建立基线;之后修改插件 → 下一轮 tick fire', async () => {
      makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      await w.ensureBaseline();
      touch('a', 'main.js', Date.now() + 5000);
      await w.tick();
      expect(fn).toHaveBeenCalledWith('a');
    });

    it('基线已建立 → ensureBaseline 不再扫描', async () => {
      makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
      const w = createPluginsWatcher(tmp, vi.fn());
      await w.tick();
      const stat = vi.spyOn(fsp, 'stat');
      await w.ensureBaseline();
      expect(stat).not.toHaveBeenCalled();
    });

    it('首扫进行中调用 ensureBaseline → 等该次扫描完成(不立即返回)', async () => {
      makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
      const fn = vi.fn();
      const w = createPluginsWatcher(tmp, fn);
      const first = w.tick(); // 在途首扫
      await w.ensureBaseline();
      // ensureBaseline 返回时基线已建立:此后修改必 fire
      touch('a', 'main.js', Date.now() + 5000);
      await first;
      await w.tick();
      expect(fn).toHaveBeenCalledWith('a');
    });

    // 单次扫描耗时超过周期(网络家目录 + 数百插件目录)时每个 tick 都会置 pending,在途循环不结束;
    // ensureBaseline 只等首轮扫描,否则 LIST_DIRS 永远等待、插件永不激活。
    it('单次扫描耗时 > 周期且持续有 tick → ensureBaseline 在首轮扫描结束后即返回', async () => {
      makeDir('a', { id: 'a', name: 'A', version: '0.1.0' });
      const realSetTimeout = globalThis.setTimeout;
      const realSleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        const realOpendir = fsp.opendir.bind(fsp);
        let scans = 0;
        vi.spyOn(fsp, 'opendir').mockImplementation((async (...args: Parameters<typeof fsp.opendir>) => {
          scans += 1;
          await new Promise((r) => setTimeout(r, 3000)); // 每轮扫描 3s > 周期 2s
          return realOpendir(...args);
        }) as typeof fsp.opendir);
        const w = createPluginsWatcher(tmp, vi.fn());
        const handle = w.start(2000, { immediate: false });
        await vi.advanceTimersByTimeAsync(2000); // 首个周期 → 首扫开始
        expect(scans).toBe(1);
        let done = false;
        void w.ensureBaseline().then(() => {
          done = true;
        });
        for (let i = 0; i < 20 && !done; i += 1) {
          await vi.advanceTimersByTimeAsync(1000);
          await realSleep(10); // 让真实 fs I/O 完成
        }
        expect(done).toBe(true);
        expect(scans).toBeGreaterThanOrEqual(2); // 循环仍在补跑(周期 tick 持续置 pending)
        handle.dispose();
        await vi.advanceTimersByTimeAsync(5000);
        await realSleep(10);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
