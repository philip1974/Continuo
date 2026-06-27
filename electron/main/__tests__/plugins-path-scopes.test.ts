import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPluginPathScopes,
  uninstallPlugin,
  writePluginPathScopes,
} from '../services/plugins.service';

const SCOPES_FILE = '_plugin-path-scopes.json';
const tempRoots: string[] = [];

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'continuo-pathscopes-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('plugins.service path-scope persistence', () => {
  it('P1 缺文件时读回空数组', async () => {
    const base = await makeBaseDir();
    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([]);
  });

  // 数据安全(codex 复查 P2):_plugin-path-scopes.json 读损坏/IO 错误时此前 catch 返回
  // {},而 writePluginPathScopes 基于此整表 RMW → 文件临时损坏时任意 plugin grant/uninstall
  // 会把其它 plugin 已持久化的 scope 抹掉。区分 ENOENT(缺文件→空)vs 损坏(存 .corrupt
  // + 写入中止),并让水合读降级返回 [](fail-safe)。
  it('P-corrupt 文件损坏时写入中止,不以空表覆盖(保留损坏内容 + .corrupt 快照)', async () => {
    const base = await makeBaseDir();
    const file = join(base, SCOPES_FILE);
    await writeFile(file, 'not valid json {{{', 'utf-8');

    await expect(
      writePluginPathScopes(base, 'com.b', [{ path: '/ws/b', mode: 'rw' }]),
    ).rejects.toThrow();

    // 损坏文件未被空表/部分覆盖
    expect(await readFile(file, 'utf-8')).toBe('not valid json {{{');
    // 保留了一次性 .corrupt 快照
    expect(existsSync(`${file}.corrupt`)).toBe(true);
  });

  it('P-corrupt 水合读损坏时降级返回 [](不抛,fail-safe)', async () => {
    const base = await makeBaseDir();
    await writeFile(join(base, SCOPES_FILE), 'corrupt}}}', 'utf-8');
    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([]);
  });

  // 数据安全(codex 复查 P1):uninstall 此前先删目录后清元数据,path-scopes 文件损坏时
  // writePluginPathScopes 抛错(#12)→ 目录已删但卸载 reject = 半卸载卡死。改 fail-fast
  // 顺序 + path-scope 清理 best-effort:损坏时仍完成卸载(目录删除),不卡死。
  it('P-uninstall path-scopes 损坏时卸载仍完成(删目录),不留半卸载', async () => {
    const base = await makeBaseDir();
    await mkdir(join(base, 'com.foo'), { recursive: true });
    await writeFile(
      join(base, 'com.foo', 'manifest.json'),
      '{"id":"com.foo"}',
      'utf-8',
    );
    // 损坏的 path-scopes 文件(writePluginPathScopes 读时会抛)
    await writeFile(join(base, SCOPES_FILE), 'corrupt}}}', 'utf-8');

    await expect(uninstallPlugin(base, 'com.foo')).resolves.toBeUndefined();
    // 目录已删(卸载完成,不卡在半提交)
    expect(existsSync(join(base, 'com.foo'))).toBe(false);
  });

  it('P2 写入后可读回(round-trip)', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/b', mode: 'r' },
    ]);
    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/b', mode: 'r' },
    ]);
  });

  it('P3 不同 plugin 互不干扰', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [{ path: '/ws/a', mode: 'rw' }]);
    await writePluginPathScopes(base, 'com.b', [{ path: '/ws/b', mode: 'r' }]);

    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
    ]);
    await expect(readPluginPathScopes(base, 'com.b')).resolves.toEqual([
      { path: '/ws/b', mode: 'r' },
    ]);
  });

  it('P4 覆盖式写入:再次写入替换该 plugin 全集', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [{ path: '/ws/a', mode: 'r' }]);
    await writePluginPathScopes(base, 'com.a', [
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/c', mode: 'rw' },
    ]);
    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/c', mode: 'rw' },
    ]);
  });

  it('P5 空数组写入删除该 id,不影响其它 plugin', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [{ path: '/ws/a', mode: 'rw' }]);
    await writePluginPathScopes(base, 'com.b', [{ path: '/ws/b', mode: 'rw' }]);

    await writePluginPathScopes(base, 'com.a', []);

    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([]);
    await expect(readPluginPathScopes(base, 'com.b')).resolves.toEqual([
      { path: '/ws/b', mode: 'rw' },
    ]);
  });

  it('P6 非法 id 被忽略,不写出畸形 key', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, '../evil', [{ path: '/ws/a', mode: 'rw' }]);
    // 文件要么不存在(从未写),要么不含该 key
    let raw = '{}';
    try {
      raw = await readFile(join(base, SCOPES_FILE), 'utf-8');
    } catch {
      // 没创建文件也是可接受的(从未触盘)
    }
    expect(raw).not.toContain('evil');
  });

  it('P7 读取时丢弃畸形条目(非数组 / 缺字段 / 非法 mode)', async () => {
    const base = await makeBaseDir();
    await writeFile(
      join(base, SCOPES_FILE),
      JSON.stringify({
        'com.ok': [{ path: '/ws/a', mode: 'rw' }],
        'com.notarray': { path: '/ws/x', mode: 'r' },
        'com.badmode': [{ path: '/ws/y', mode: 'x' }],
        'com.missing': [{ mode: 'r' }],
      }),
      'utf-8',
    );

    await expect(readPluginPathScopes(base, 'com.ok')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
    ]);
    await expect(readPluginPathScopes(base, 'com.notarray')).resolves.toEqual([]);
    await expect(readPluginPathScopes(base, 'com.badmode')).resolves.toEqual([]);
    await expect(readPluginPathScopes(base, 'com.missing')).resolves.toEqual([]);
  });

  // 边界(E249,E247 兄弟入口 / E246 写读 cap 对称):service 入口绕过 IPC schema 写超量 scopes 时,写端按
  // MAX_PERSISTED_SCOPES_PER_PLUGIN(256)有界收集**落盘**。断言磁盘原始内容(非 readPluginPathScopes ——
  // 它自身也 re-cap,会掩盖写端无界,同 E247 教训)。
  it('E249 写超量 scopes(>256)→ 服务层按 MAX(256)截断落盘(磁盘原始内容)', async () => {
    const base = await makeBaseDir();
    const scopes = Array.from({ length: 300 }, (_, i) => ({
      path: `/ws/${i}`,
      mode: 'r' as const,
    }));
    await writePluginPathScopes(base, 'com.big', scopes);
    const raw = JSON.parse(
      await readFile(join(base, SCOPES_FILE), 'utf-8'),
    ) as Record<string, unknown[]>;
    expect(raw['com.big']?.length).toBe(256); // 落盘即截断,非 300
  });
});
