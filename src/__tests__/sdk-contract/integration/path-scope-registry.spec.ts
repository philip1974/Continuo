import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityRegistry } from '../../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../../electron/main/services/path-scope-registry.service';
import { ScopeError } from '../../../plugins/types';

let tmpRoot: string;
let tmpCanonical: string;
let ids: IdentityRegistry;
let reg: PathScopeRegistry;
let token: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), `sdk-contract-scope-${randomUUID()}-`));
  tmpCanonical = await realpath(tmpRoot);
  ids = new IdentityRegistry();
  reg = new PathScopeRegistry(ids);
  token = ids.register('plugin-x', 42).token;
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('sdk-contract integration: PathScopeRegistry', () => {
  it('T1 grant read scope allows read checks for registered token', async () => {
    const target = join(tmpRoot, 'readme.txt');
    await writeFile(target, 'hello', 'utf-8');
    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'r' }]);

    await expect(
      reg.check(token, 42, 'read', target, 'r'),
    ).resolves.toMatchObject({ canonical: await realpath(target) });
  });

  // 边界(E178):check() 是所有 plugin-fs 操作的 chokepoint;target 路径在 resolveForX→realpath 之前
  // 须 type + 长度前置闸(FS_PATH_MAX),与主 fs.ipc 对齐。超长合法路径触发 ENAMETOOLONG/CPU·内存放大,
  // 非 string 变 TypeError。统一拦在 realpath 之前,错误稳定 SCOPE_ERROR 且不回显原始超长 target。
  it('E178 超长 target(> FS_PATH_MAX)→ ScopeError(target-invalid),不回显原始超长串', async () => {
    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'rw' }]);
    const longTarget = join(tmpCanonical, 'x'.repeat(9000)); // > 8192
    const err = await reg
      .check(token, 42, 'read', longTarget, 'r')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect((err as ScopeError).details?.reason).toBe('target-invalid');
    expect((err as Error).message).not.toContain('x'.repeat(100)); // 不回显原始超长串
  });

  it('E178 非字符串 / 空 target → ScopeError(非 TypeError)', async () => {
    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'rw' }]);
    for (const bad of [null, undefined, 42, {}, '']) {
      await expect(
        reg.check(token, 42, 'read', bad as unknown as string, 'r'),
      ).rejects.toBeInstanceOf(ScopeError);
    }
  });

  it('T2 read-only scope denies write checks', async () => {
    const target = join(tmpRoot, 'write.txt');
    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'r' }]);

    await expect(reg.check(token, 42, 'write', target, 'rw')).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it('T3 rw grant upgrades existing read scope and allows write checks', async () => {
    const target = join(tmpRoot, 'write.txt');
    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'r' }]);
    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'rw' }]);

    await expect(reg.check(token, 42, 'write', target, 'rw')).resolves.toMatchObject({
      fullPath: join(tmpCanonical, 'write.txt'),
    });
    expect(reg._peek('plugin-x')).toEqual([{ path: tmpCanonical, mode: 'rw' }]);
  });

  it('T4 emits scope-updated when grant changes scopes', () => {
    const listener = vi.fn();
    reg.on('scope-updated', listener);

    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'r' }]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      pluginId: 'plugin-x',
      scopes: [{ path: tmpCanonical, mode: 'r' }],
    });
  });

  it('T5 revokeAll removes all scopes and later checks reject', async () => {
    const target = join(tmpRoot, 'readme.txt');
    await writeFile(target, 'hello', 'utf-8');
    reg.grant('plugin-x', [{ path: tmpCanonical, mode: 'r' }]);
    reg.revokeAll('plugin-x');

    await expect(reg.check(token, 42, 'read', target, 'r')).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  // 边界(E81,E79 注册表数量上限族):mergeScopes 加 per-plugin(256)+ 全局(4096)唯一-path 上限。
  // grant/hydrate 都经 mergeScopes,多次请求不同路径不会无界撑大 pluginScopes / 持久化文件。
  const PER_PLUGIN = 256;
  const GLOBAL = 4096;

  it('E81 单 plugin 授权超 256 唯一 path → 截断到上限(fail-closed)', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      path: `/s/x/${i}`,
      mode: 'r' as const,
    }));
    reg.grant('plugin-x', many);
    expect(reg._peek('plugin-x')).toHaveLength(PER_PLUGIN);
  });

  it('E81 已存在 path 放宽 mode 不增计数(r→rw)', () => {
    const many = Array.from({ length: PER_PLUGIN }, (_, i) => ({
      path: `/s/x/${i}`,
      mode: 'r' as const,
    }));
    reg.grant('plugin-x', many); // 填满
    // 对已存在 path 升级 mode → 计数不变,仍在上限,且 mode 升为 rw
    reg.grant('plugin-x', [{ path: '/s/x/0', mode: 'rw' }]);
    const scopes = reg._peek('plugin-x');
    expect(scopes).toHaveLength(PER_PLUGIN);
    expect(scopes.find((s) => s.path === '/s/x/0')?.mode).toBe('rw');
  });

  it('E81 revokeAll 释放全局名额', () => {
    // 16 plugin × 256 = 4096 占满全局
    for (let p = 0; p < GLOBAL / PER_PLUGIN; p += 1) {
      reg.grant(
        `g${p}`,
        Array.from({ length: PER_PLUGIN }, (_, i) => ({
          path: `/s/g${p}/${i}`,
          mode: 'r' as const,
        })),
      );
    }
    // 全局已满:新 plugin 授权被丢弃
    reg.grant('overflow', [{ path: '/s/overflow/0', mode: 'r' }]);
    expect(reg._peek('overflow')).toHaveLength(0);
    // 释放一个 plugin 的名额后,新授权可入
    reg.revokeAll('g0');
    reg.grant('overflow', [{ path: '/s/overflow/0', mode: 'r' }]);
    expect(reg._peek('overflow')).toHaveLength(1);
  });
});
