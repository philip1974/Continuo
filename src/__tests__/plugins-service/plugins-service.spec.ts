import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  promises as fsp,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listPluginDirs,
  readEnabledIds,
  readFileCapped,
  readPermissions,
  readPluginPathScopes,
  resolvePluginMainPath,
  uninstallPlugin,
  writeEnabledIds,
  writePermissions,
  writePluginPathScopes,
} from '../../../electron/main/services/plugins.service';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lm-plugins-'));
});
afterEach(() => {
  // 即使某测试断言失败、未走到手动 spy.mockRestore() 也能复原 fs spy,防 mock 泄漏到后续测试。
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function makeDir(id: string, manifest: object, mainText = '/* main */', stylesText?: string) {
  const dir = join(tmp, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'main.js'), mainText);
  if (stylesText !== undefined) writeFileSync(join(dir, 'styles.css'), stylesText);
}

describe('listPluginDirs', () => {
  it('baseDir 不存在 → []', async () => {
    expect(await listPluginDirs(join(tmp, 'nope'))).toEqual([]);
  });

  it('空 baseDir → []', async () => {
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('收 manifest+main.js 完整目录', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    const r = await listPluginDirs(tmp);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('com.foo');
    expect(r[0]!.manifestText).toContain('"id":"com.foo"');
    expect(r[0]!.mainText).toBe('/* main */');
    expect(r[0]!.stylesText).toBeUndefined();
  });

  it('含 styles.css → stylesText 透传', async () => {
    makeDir(
      'com.bar',
      { id: 'com.bar', name: 'Bar', version: '0.1.0' },
      '/* main */',
      '.foo{}',
    );
    const r = await listPluginDirs(tmp);
    expect(r[0]!.stylesText).toBe('.foo{}');
  });

  // 边界(E24):manifest/main/styles 超大小上限 → 跳过(不整文件读入 + IPC 传输)。用稀疏 truncate
  // 扩展(不写实际数据);stat.size 在 readFile 之前拦截。
  it('E24 manifest 超 1MiB → 跳过整插件', async () => {
    makeDir('p.bigman', { id: 'p.bigman', name: 'X', version: '0.1.0' });
    await fsp.truncate(join(tmp, 'p.bigman', 'manifest.json'), 1024 * 1024 + 1);
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('E24 main 超 8MiB → 跳过整插件', async () => {
    makeDir('p.bigmain', { id: 'p.bigmain', name: 'X', version: '0.1.0' });
    await fsp.truncate(join(tmp, 'p.bigmain', 'main.js'), 8 * 1024 * 1024 + 1);
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('E24 styles 超 4MiB → 当无样式,插件仍收', async () => {
    makeDir(
      'p.bigsty',
      { id: 'p.bigsty', name: 'X', version: '0.1.0' },
      '/* main */',
      'body{}',
    );
    await fsp.truncate(join(tmp, 'p.bigsty', 'styles.css'), 4 * 1024 * 1024 + 1);
    const r = await listPluginDirs(tmp);
    expect(r).toHaveLength(1);
    expect(r[0]!.stylesText).toBeUndefined();
  });

  it('缺 manifest.json → 跳过', async () => {
    const dir = join(tmp, 'nomanifest');
    mkdirSync(dir);
    writeFileSync(join(dir, 'main.js'), '/* */');
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  // 边界(E158,E24 TOCTOU 修正):readFileCapped 改为单 fd 至多读 maxBytes+1 字节(不再 stat→readFile
  // 两步,消除检查与读取之间文件被替换/增长绕过上限的窗口),读取量恒有界。
  describe('E158 readFileCapped 单 fd 有界读', () => {
    it('文件 ≤ maxBytes → 原样返回内容', async () => {
      const p = join(tmp, 'small.txt');
      writeFileSync(p, 'hello');
      expect(await readFileCapped(p, 100)).toBe('hello');
    });

    it('文件恰好 == maxBytes → 返回(边界含等号)', async () => {
      const p = join(tmp, 'exact.txt');
      const content = 'a'.repeat(64);
      writeFileSync(p, content);
      expect(await readFileCapped(p, 64)).toBe(content);
    });

    it('文件 > maxBytes → null(超限跳过,不整文件读入)', async () => {
      const p = join(tmp, 'big.txt');
      writeFileSync(p, 'a'.repeat(65));
      expect(await readFileCapped(p, 64)).toBeNull();
    });

    it('稀疏超大文件(truncate)> maxBytes → null', async () => {
      const p = join(tmp, 'sparse.bin');
      writeFileSync(p, '');
      await fsp.truncate(p, 8 * 1024 * 1024 + 1);
      expect(await readFileCapped(p, 8 * 1024 * 1024)).toBeNull();
    });

    it('缺失文件 → null', async () => {
      expect(await readFileCapped(join(tmp, 'nope.txt'), 100)).toBeNull();
    });

    it('多字节 UTF-8 内容正确解码(不拆坏字符)', async () => {
      const p = join(tmp, 'cjk.txt');
      const content = '中文测试';
      writeFileSync(p, content, 'utf-8');
      expect(await readFileCapped(p, 1024)).toBe(content);
    });
  });

  it('缺 main.js → 跳过', async () => {
    const dir = join(tmp, 'nomain');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id: 'x', name: 'X', version: '0.1.0' }),
    );
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('manifest.main 自定义入口', async () => {
    const dir = join(tmp, 'custom');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'custom',
        name: 'X',
        version: '0.1.0',
        main: 'index.js',
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'CUSTOM');
    const r = await listPluginDirs(tmp);
    expect(r[0]!.mainText).toBe('CUSTOM');
  });

  // 边界(E102):manifest.main 超长(>512)→ getPluginMainName 退默认 main.js(不把近 1MiB main
  // 名进 resolvePluginMainPath split/resolve)。提供真实 main.js → 插件仍以 main.js 收入。
  it('E102 manifest.main 超长(>512)→ 退默认 main.js', async () => {
    const dir = join(tmp, 'overmain');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'overmain',
        name: 'X',
        version: '0.1.0',
        main: `${'x'.repeat(600)}.js`,
      }),
    );
    writeFileSync(join(dir, 'main.js'), 'FALLBACK');
    const r = await listPluginDirs(tmp);
    expect(r.find((x) => x.id === 'overmain')?.mainText).toBe('FALLBACK');
  });

  it('manifest.main 允许插件目录内的子目录入口', async () => {
    const dir = join(tmp, 'nested-main');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'nested-main',
        name: 'X',
        version: '0.1.0',
        main: 'dist/index.js',
      }),
    );
    writeFileSync(join(dir, 'dist', 'index.js'), 'NESTED');

    const r = await listPluginDirs(tmp);
    expect(r[0]!.mainText).toBe('NESTED');
  });

  it('manifest.main 含 .. 时跳过插件,不读取目录外文件', async () => {
    const dir = join(tmp, 'escape');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'escape',
        name: 'X',
        version: '0.1.0',
        main: '../outside.js',
      }),
    );
    writeFileSync(join(tmp, 'outside.js'), 'OUTSIDE');

    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('manifest.main 是绝对路径时跳过插件', async () => {
    const dir = join(tmp, 'absolute');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'absolute',
        name: 'X',
        version: '0.1.0',
        main: join(tmp, 'outside.js'),
      }),
    );
    writeFileSync(join(tmp, 'outside.js'), 'OUTSIDE');

    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('resolvePluginMainPath 只返回插件目录内路径', () => {
    const dir = join(tmp, 'safe');
    expect(resolvePluginMainPath(dir, 'dist/index.js')).toBe(
      join(dir, 'dist', 'index.js'),
    );
    expect(resolvePluginMainPath(dir, '../outside.js')).toBeNull();
    expect(resolvePluginMainPath(dir, '/tmp/outside.js')).toBeNull();
    expect(resolvePluginMainPath(dir, String.raw`C:\tmp\outside.js`)).toBeNull();
  });

  it('忽略 . / _ 开头的目录', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    mkdirSync(join(tmp, '.git'));
    mkdirSync(join(tmp, '_internal'));
    writeFileSync(join(tmp, '_enabled.json'), '[]');
    const r = await listPluginDirs(tmp);
    expect(r.map((x) => x.id)).toEqual(['com.foo']);
  });

  it('普通文件不视为目录', async () => {
    writeFileSync(join(tmp, 'README.md'), '# hi');
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  // 边界(E82,E30/E24 同族):插件目录枚举 opendir 惰性 + 条目数上限(1024)。被污染目录放入海量
  // 条目时不整目录读入,累计到上限即停 + 告警。用 fake Dir 免真实创建 5000 目录。
  it('E82 目录条目数超上限 → 惰性枚举累计到 1024 即停 + 告警', async () => {
    let yielded = 0;
    const fakeDir = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 5000; i += 1) {
          yielded += 1;
          yield { name: `p${i}` };
        }
      },
    };
    vi.spyOn(fsp, 'opendir').mockResolvedValue(
      fakeDir as unknown as Awaited<ReturnType<typeof fsp.opendir>>,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await listPluginDirs(tmp);
    // 惰性迭代累计到上限即停:消费的 dirent 数 ≤ 1024,远小于 5000(不整目录读入)。
    expect(yielded).toBeLessThanOrEqual(1024);
    expect(warn).toHaveBeenCalled(); // 截断告警
  });
});

describe('readEnabledIds / writeEnabledIds', () => {
  it('未写过 → []', async () => {
    expect(await readEnabledIds(tmp)).toEqual([]);
  });

  it('write + read 往返', async () => {
    await writeEnabledIds(tmp, ['a', 'b']);
    expect(await readEnabledIds(tmp)).toEqual(['a', 'b']);
  });

  it('文件含非 string → 返 []', async () => {
    writeFileSync(join(tmp, '_enabled.json'), JSON.stringify(['ok', 1]));
    expect(await readEnabledIds(tmp)).toEqual([]);
  });

  // 边界(E85,数据完整性 / E74 字段上限族):读盘 canonicalize —— 丢非法 id(非 isSafePluginId /
  // 超长)、去重,合法 id 保留。防 1MiB 内数十万短串/非法 id 进 Set/init 放大 + RMW 原样写回。
  it('E85 读盘过滤非法/超长 id + 去重(canonicalize)', async () => {
    writeFileSync(
      join(tmp, '_enabled.json'),
      JSON.stringify([
        'com.good',
        'BadUpper', // 大写非法
        'has space', // 空格非法
        'x'.repeat(300), // 超长
        '..', // 路径段非法
        'com.good', // 重复
        'com.also-ok',
      ]),
    );
    expect(await readEnabledIds(tmp)).toEqual(['com.good', 'com.also-ok']);
  });

  it('E85 超过数量上限 → 截断到 MAX_ENABLED_IDS', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `com.p${i}`);
    writeFileSync(join(tmp, '_enabled.json'), JSON.stringify(many));
    expect(await readEnabledIds(tmp)).toHaveLength(4096);
  });

  // 边界(E206,E197-E199 有界迭代族-数组变体):类型校验并入 capped 循环,不先 json.every() 全量遍历。
  // 非字符串在数量上限之后 → 凑满 MAX_ENABLED_IDS 即 break,从不扫到末尾的非字符串 → 返前 4096。
  // (中和回 json.every() 全量预扫 → 扫到末尾非字符串会返 [],该测失败。)
  it('E206 非字符串在数量上限之后 → 不全量预扫(凑满即停,返 4096)', async () => {
    const many = Array.from({ length: 4096 }, (_, i) => `com.p${i}`);
    writeFileSync(
      join(tmp, '_enabled.json'),
      JSON.stringify([...many, 12345]), // 末尾混入非字符串,但在 4096 上限之后
    );
    expect(await readEnabledIds(tmp)).toHaveLength(4096);
  });

  it('文件 JSON 损坏 → 返 []', async () => {
    writeFileSync(join(tmp, '_enabled.json'), '{{{');
    expect(await readEnabledIds(tmp)).toEqual([]);
  });

  // 数据安全(codex 复查 P1):非 ENOENT 读错误(EACCES/EIO)此前也降级 []，mutateEnabledIds
  // 随后基于空集合 RMW 抹掉其它已启用插件。只 ENOENT→[],其它读错误抛出(同型清扫第 4 个读点)。
  // 边界(E159):readMetadataCapped 改单 fd 后,EACCES 经 fs.open 抛出透传(原 readFile 改 open)。
  it('非 ENOENT 读错误(EACCES 等)→ 抛出,不当空列表', async () => {
    writeFileSync(join(tmp, '_enabled.json'), '[]');
    const spy = vi
      .spyOn(fsp, 'open')
      .mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
    await expect(readEnabledIds(tmp)).rejects.toThrow();
    spy.mockRestore();
  });

  // 边界(E68,E18/E26/E66/E67 stat-before-read 族;E159 TOCTOU 修正):元数据读前经单 fd fstat 硬拦
  // (1MiB)。超大 → 抛(同 EACCES「当前态未知」,绝不当空列表降级,否则 RMW 抹其它已启用插件),且
  // 在 readFhCapped 之前 fail-fast 不整块读入。用真实稀疏文件(truncate),覆盖单 fd fstat 路径。
  it('E68/E159 文件超 1MiB(单 fd fstat 预检)→ 抛出,不当空列表', async () => {
    writeFileSync(join(tmp, '_enabled.json'), '[]');
    await fsp.truncate(join(tmp, '_enabled.json'), 2 * 1024 * 1024);
    await expect(readEnabledIds(tmp)).rejects.toThrow(/too large/i);
  });

  it('write 时自动 mkdir -p', async () => {
    const sub = join(tmp, 'nested', 'plugins');
    await writeEnabledIds(sub, ['x']);
    expect(await readEnabledIds(sub)).toEqual(['x']);
  });
});

// ── v4.2 权限决策持久化 ─────────────────────────────────

describe('readPermissions / writePermissions', () => {
  it('未写过 → {}', async () => {
    expect(await readPermissions(tmp)).toEqual({});
  });

  it('write + read 往返(多 plugin 多 decision)', async () => {
    await writePermissions(tmp, {
      'p.a': [
        { permission: 'fs', granted: true, decidedAt: 1000 },
        { permission: 'network', granted: false, decidedAt: 1100 },
      ],
      'p.b': [{ permission: 'shell', granted: true, decidedAt: 2000 }],
    });
    const r = await readPermissions(tmp);
    // M6:IpcPermissionsMap 为 union(数组 | {decisions,pathScopes});这里写的是数组形态,
    // 用 Array.isArray 窄化后再索引。
    const pa = r['p.a'];
    const pb = r['p.b'];
    if (!Array.isArray(pa) || !Array.isArray(pb)) throw new Error('expected array shape');
    expect(pa).toHaveLength(2);
    expect(pb).toHaveLength(1);
    expect(pa[0]!.permission).toBe('fs');
  });

  it('新形态 { decisions, pathScopes } write+read 往返保留(数据安全 P1)', async () => {
    // codex 复查:此前 readPermissions 只读数组形态,对象形态被整条丢弃 →
    // 重启后 decisions + pathScopes(fs 授权)全失,违反 IpcPermissionRecord round-trip。
    await writePermissions(tmp, {
      'p.scoped': {
        decisions: [{ permission: 'fs', granted: true, decidedAt: 5 }],
        pathScopes: [{ path: '/ws/proj', mode: 'rw' }],
      },
    });
    const rec = (await readPermissions(tmp))['p.scoped'];
    if (Array.isArray(rec) || !rec) throw new Error('expected object shape preserved');
    expect(rec.decisions).toHaveLength(1);
    expect(rec.decisions[0]!.permission).toBe('fs');
    expect(rec.pathScopes).toEqual([{ path: '/ws/proj', mode: 'rw' }]);
  });

  it('对象形态 decisions 非法 → 该 pluginId 跳过(校验防脏数据)', async () => {
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({ bad: { decisions: [{ permission: 'fs' /* no granted */ }] } }),
    );
    expect((await readPermissions(tmp)).bad).toBeUndefined();
  });

  // 边界(E207,E206 同族):decisions/pathScopes 用 cappedAllValid 有界校验,不先 .every() 全量扫描。
  // 上限内任一非法 → 整条丢弃(契约保留,见上面 421 测试);非法项落在上限之后 → 凑满即停、不扫到它
  //(返前 MAX_DECISIONS_PER_PLUGIN 条)。中和回 value.every(isDecision) 全扫到非法 → 整条丢弃,该测失败。
  it('E207 array-form decisions:非法项在上限之后 → 不全量预扫,保留前 1000 条', async () => {
    const valid = Array.from({ length: 1000 }, (_, i) => ({
      permission: 'fs' as const,
      granted: true,
      decidedAt: i,
    }));
    writeFileSync(
      join(tmp, '_permissions.json'),
      // 末尾混入非法 decision(无 granted),但在 MAX_DECISIONS_PER_PLUGIN(1000)上限之后
      JSON.stringify({ 'com.many': [...valid, { permission: 'fs' }] }),
    );
    const rec = (await readPermissions(tmp))['com.many'];
    if (!Array.isArray(rec)) throw new Error('expected array shape');
    expect(rec).toHaveLength(1000); // 凑满 1000 即停,从不扫到末尾非法项(旧 every 全扫 → 整条丢弃 undefined)
  });

  it('E207 array-form decisions:非法项在上限之内 → 整条丢弃(契约保留)', async () => {
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({
        'com.bad': [
          { permission: 'fs', granted: true, decidedAt: 1 },
          { permission: 'fs' /* no granted */ }, // 上限内非法
        ],
      }),
    );
    expect((await readPermissions(tmp))['com.bad']).toBeUndefined();
  });

  it('E207 object-form pathScopes:非法项在上限之后 → 保留前 256 条', async () => {
    const validScopes = Array.from({ length: 256 }, (_, i) => ({
      path: `/ws/p${i}`,
      mode: 'rw' as const,
    }));
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({
        'com.scoped': {
          decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }],
          pathScopes: [...validScopes, { path: 123 /* 非法 */ }],
        },
      }),
    );
    const rec = (await readPermissions(tmp))['com.scoped'];
    if (Array.isArray(rec) || !rec) throw new Error('expected object shape');
    expect(rec.pathScopes).toHaveLength(256);
  });

  it('JSON 损坏 → {}', async () => {
    writeFileSync(join(tmp, '_permissions.json'), '{{{');
    expect(await readPermissions(tmp)).toEqual({});
  });

  // 数据安全(codex 复查 P1):非 ENOENT 读错误(EACCES/EIO)此前也降级 {},writePluginPermissions
  // 随后基于空表 RMW 会抹掉其它 plugin 授权。只 ENOENT→{},其它读错误抛出(与 path-scopes 同型)。
  // 边界(E159):readMetadataCapped 改单 fd 后,EACCES 经 fs.open 抛出透传(原 readFile 改 open)。
  it('非 ENOENT 读错误(EACCES 等)→ 抛出,不当空表', async () => {
    writeFileSync(join(tmp, '_permissions.json'), '{}');
    const spy = vi
      .spyOn(fsp, 'open')
      .mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
    await expect(readPermissions(tmp)).rejects.toThrow();
    spy.mockRestore();
  });

  // 边界(E68;E159 TOCTOU 修正):同 readEnabledIds —— 单 fd fstat 硬拦,超大抛(不当空表降级,防 RMW
  // 抹授权)。用真实稀疏文件覆盖单 fd fstat 路径。
  it('E68/E159 文件超 1MiB(单 fd fstat 预检)→ 抛出,不当空表', async () => {
    writeFileSync(join(tmp, '_permissions.json'), '{}');
    await fsp.truncate(join(tmp, '_permissions.json'), 2 * 1024 * 1024);
    await expect(readPermissions(tmp)).rejects.toThrow(/too large/i);
  });

  it('顶层非 object(数组)→ {}', async () => {
    writeFileSync(join(tmp, '_permissions.json'), '[]');
    expect(await readPermissions(tmp)).toEqual({});
  });

  it('value 含非 decision 形状的项 → 该 pluginId 跳过', async () => {
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({
        good: [{ permission: 'fs', granted: true, decidedAt: 1 }],
        bad: [{ permission: 'fs' /* missing granted */ }],
      }),
    );
    const r = await readPermissions(tmp);
    expect(r.good).toHaveLength(1);
    expect(r.bad).toBeUndefined();
  });

  it('write 时自动 mkdir -p', async () => {
    const sub = join(tmp, 'deep', 'plugins');
    await writePermissions(sub, {
      'p.x': [{ permission: 'fs', granted: true, decidedAt: 1 }],
    });
    expect((await readPermissions(sub))['p.x']).toHaveLength(1);
  });

  // 边界(E87,E85/E86 数据完整性族):读盘 canonicalize —— permission 非枚举/decidedAt 非有限/
  // 非法 plugin key 过滤,防 PERM_LABEL_KEYS[perm]=undefined 渲染崩 + RMW 写回绕过写端上限。
  it('E87 permission 非 PERMISSION_KEYS 成员 → 该记录丢弃', async () => {
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({
        'com.good': [{ permission: 'fs', granted: true, decidedAt: 1 }],
        'com.bad': [{ permission: 'not-a-perm', granted: true, decidedAt: 1 }],
      }),
    );
    const r = await readPermissions(tmp);
    expect(Object.keys(r)).toEqual(['com.good']); // 非枚举权限记录丢弃
  });

  it('E87 decidedAt 非有限(1e400→Infinity)→ 该记录丢弃', async () => {
    writeFileSync(
      join(tmp, '_permissions.json'),
      '{"com.good":[{"permission":"fs","granted":true,"decidedAt":1}],"com.inf":[{"permission":"fs","granted":true,"decidedAt":1e400}]}',
    );
    const r = await readPermissions(tmp);
    expect(Object.keys(r)).toEqual(['com.good']);
  });

  it('E87 非法 plugin key + decisions 数超上限', async () => {
    const many = Array.from({ length: 1500 }, () => ({
      permission: 'fs' as const,
      granted: true,
      decidedAt: 1,
    }));
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({
        'Bad Key': [{ permission: 'fs', granted: true, decidedAt: 1 }], // 非 isSafePluginId
        'com.many': many,
      }),
    );
    const r = await readPermissions(tmp);
    expect(Object.keys(r)).toEqual(['com.many']); // 'Bad Key' 丢弃
    const rec = r['com.many'];
    if (!Array.isArray(rec)) throw new Error('expected array');
    expect(rec).toHaveLength(1000); // decisions 截断到上限
  });

  // 边界(E199,E197/E198 同族有界迭代,主进程对偶):readPermissions/readAllPathScopes 单次 for...in
  // 惰性遍历,不先 Object.entries 把被污染数据文件的所有 plugin key 全量物化(再 break=上限失效)。
  // spy 筛选:只看「以含这两个 key 的目标对象为参」的 Object.entries 调用,免全套并行下其它文件的
  // 全局 Object.entries 调用污染计数(Object 是全局,异步 await 期间可能有别处调用)。
  const entriesCalledOn = (
    spy: ReturnType<typeof vi.spyOn>,
    ...keys: string[]
  ): boolean =>
    spy.mock.calls.some(
      (c) =>
        c[0] != null &&
        typeof c[0] === 'object' &&
        keys.every((k) => k in (c[0] as object)),
    );

  it('E199 readPermissions 不对 permissions 对象调 Object.entries(单次 for...in,不全量物化)', async () => {
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({
        'com.a': [{ permission: 'fs', granted: true, decidedAt: 1 }],
        'com.b': [{ permission: 'shell', granted: true, decidedAt: 1 }],
      }),
    );
    const spy = vi.spyOn(Object, 'entries');
    const r = await readPermissions(tmp);
    const materialized = entriesCalledOn(spy, 'com.a', 'com.b');
    spy.mockRestore();
    expect(materialized).toBe(false); // 中和回 Object.entries 版 → true
    expect(Object.keys(r).sort()).toEqual(['com.a', 'com.b']); // 行为回归
  });

  it('E199 readAllPathScopes(经 readPluginPathScopes)不对 scopes 对象调 Object.entries', async () => {
    writeFileSync(
      join(tmp, '_plugin-path-scopes.json'),
      JSON.stringify({
        'com.a': [{ path: '/a', mode: 'r' }],
        'com.b': [{ path: '/b', mode: 'rw' }],
      }),
    );
    const spy = vi.spyOn(Object, 'entries');
    const scopes = await readPluginPathScopes(tmp, 'com.a');
    const materialized = entriesCalledOn(spy, 'com.a', 'com.b');
    spy.mockRestore();
    expect(materialized).toBe(false);
    expect(scopes).toHaveLength(1); // 行为回归:com.a 的 scope 读到
  });
});

// ── v4.6 卸载 ──────────────────────────────────────────

describe('uninstallPlugin', () => {
  it('id 含非法字符 → INVALID_ID,不动文件系统', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    await expect(uninstallPlugin(tmp, '../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
    // 既有目录没被影响
    expect(await listPluginDirs(tmp)).toHaveLength(1);
  });

  it('插件目录不存在 → NOT_INSTALLED', async () => {
    await expect(uninstallPlugin(tmp, 'com.notexist')).rejects.toMatchObject({
      code: 'NOT_INSTALLED',
    });
  });

  it('正常路径:删目录 + 从 _enabled.json 摘 id', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    makeDir('com.bar', { id: 'com.bar', name: 'Bar', version: '0.1.0' });
    await writeEnabledIds(tmp, ['com.foo', 'com.bar']);

    await uninstallPlugin(tmp, 'com.foo');

    expect((await listPluginDirs(tmp)).map((x) => x.id)).toEqual(['com.bar']);
    expect(await readEnabledIds(tmp)).toEqual(['com.bar']);
  });

  it('正常路径:从 _permissions.json 摘 id', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    await writePermissions(tmp, {
      'com.foo': [{ permission: 'fs', granted: true, decidedAt: 1 }],
      'com.bar': [{ permission: 'network', granted: true, decidedAt: 2 }],
    });

    await uninstallPlugin(tmp, 'com.foo');

    const perms = await readPermissions(tmp);
    expect(perms['com.foo']).toBeUndefined();
    expect(perms['com.bar']).toHaveLength(1);
  });

  it('id 不在 _enabled / _permissions 中 → 不报错,只删目录', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    await writeEnabledIds(tmp, ['com.bar']); // foo 不在内
    await uninstallPlugin(tmp, 'com.foo');
    expect(await listPluginDirs(tmp)).toEqual([]);
    expect(await readEnabledIds(tmp)).toEqual(['com.bar']);
  });
});

// 边界(E86,E85/E74 数据完整性族):_plugin-path-scopes.json 读盘 canonicalize —— 非法 key /
// 超长 path / 超量 scope 过滤,RMW 写回也清理整表。
describe('readPluginPathScopes / writePluginPathScopes 读盘 canonicalize (E86)', () => {
  it('E86 超长 path scope → 读盘过滤(只留合法)', async () => {
    writeFileSync(
      join(tmp, '_plugin-path-scopes.json'),
      JSON.stringify({
        'com.good': [
          { path: '/ok', mode: 'r' },
          { path: 'x'.repeat(9000), mode: 'r' }, // 超 8192 → 过滤
        ],
      }),
    );
    expect(await readPluginPathScopes(tmp, 'com.good')).toEqual([
      { path: '/ok', mode: 'r' },
    ]);
  });

  it('E86 非法 plugin key → 读盘丢弃,RMW 写回清理整表', async () => {
    writeFileSync(
      join(tmp, '_plugin-path-scopes.json'),
      JSON.stringify({
        'com.good': [{ path: '/g', mode: 'r' }],
        'Bad Key': [{ path: '/b', mode: 'rw' }], // 非 isSafePluginId(空格)
      }),
    );
    // 触发 RMW:写另一个合法 plugin → 读端 canonicalize 丢 'Bad Key',写回不含它
    await writePluginPathScopes(tmp, 'com.new', [{ path: '/n', mode: 'r' }]);
    const raw = JSON.parse(
      readFileSync(join(tmp, '_plugin-path-scopes.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['com.good', 'com.new']); // 'Bad Key' 已清
  });

  it('E86 每插件 scope 数超上限 → 截断到 256', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      path: `/s/${i}`,
      mode: 'r' as const,
    }));
    writeFileSync(
      join(tmp, '_plugin-path-scopes.json'),
      JSON.stringify({ 'com.good': many }),
    );
    expect(await readPluginPathScopes(tmp, 'com.good')).toHaveLength(256);
  });

  // 边界(E208,E206/E207 有界迭代族):每 plugin scope 数组用 collectValidCapped 凑满即停,不先
  // value.filter(isIpcPathScope) 全量扫描+物化再 slice。结果与旧 filter+slice 相同(前 256 合法),
  // 故用 Array.prototype.filter spy(按 257 长度筛选,免并行污染)验"不再对超长 scope 数组调 filter"。
  it('E208 readAllPathScopes 不对超长 scope 数组调 .filter(凑满即停)', async () => {
    const many = Array.from({ length: 257 }, (_, i) => ({
      path: `/s/${i}`,
      mode: 'r' as const,
    }));
    writeFileSync(
      join(tmp, '_plugin-path-scopes.json'),
      JSON.stringify({ 'com.good': many }),
    );
    const filterSpy = vi.spyOn(Array.prototype, 'filter');
    const scopes = await readPluginPathScopes(tmp, 'com.good');
    const filteredScopeArray = filterSpy.mock.instances.some(
      (inst) => Array.isArray(inst) && (inst as unknown[]).length === 257,
    );
    filterSpy.mockRestore();
    expect(filteredScopeArray).toBe(false); // 新实现不对 257-len scope 数组 filter(旧 filter+slice 会)
    expect(scopes).toHaveLength(256); // 结果回归:前 256 合法
  });

  it('writePluginPathScopes 归一化不通过中间数组 .map 二次遍历', async () => {
    const many = Array.from({ length: 257 }, (_, i) => ({
      path: `/w/${i}`,
      mode: 'r' as const,
      extra: 'drop-me',
    }));
    const mapSpy = vi.spyOn(Array.prototype, 'map');
    try {
      await writePluginPathScopes(tmp, 'com.write', many);
      const mappedScopeArray = mapSpy.mock.instances.some(
        (inst) => Array.isArray(inst) && (inst as unknown[]).length === 256,
      );
      expect(mappedScopeArray).toBe(false);
    } finally {
      mapSpy.mockRestore();
    }

    const raw = JSON.parse(
      readFileSync(join(tmp, '_plugin-path-scopes.json'), 'utf-8'),
    ) as Record<string, Array<Record<string, unknown>>>;
    expect(raw['com.write']).toHaveLength(256);
    expect(raw['com.write']![0]).toEqual({ path: '/w/0', mode: 'r' });
    expect(raw['com.write']![255]).toEqual({ path: '/w/255', mode: 'r' });
  });
});
