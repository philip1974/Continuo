import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PluginIdentityError,
  ScopeError,
  type PathScope,
} from '../../../src/plugins/types';
import { IdentityRegistry } from '../services/identity-registry.service';
import {
  PathScopeRegistry,
  type ScopeUpdatedEvent,
} from '../services/path-scope-registry.service';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'continuo-scope-'));
  tempRoots.push(dir);
  return dir;
}

function makeHarness(): {
  identity: IdentityRegistry;
  registry: PathScopeRegistry;
  token: string;
} {
  const identity = new IdentityRegistry();
  const registry = new PathScopeRegistry(identity);
  const { token } = identity.register('com.test', 10);
  return { identity, registry, token };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('PathScopeRegistry', () => {
  it('T1.a grant + check read happy', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();
    const nested = join(root, 'bar');
    const file = join(nested, 'baz.txt');
    mkdirSync(nested, { recursive: true });
    writeFileSync(file, 'ok');

    registry.grant('com.test', [{ path: realpathSync(root), mode: 'r' }]);

    await expect(registry.check(token, 10, 'read', file, 'r')).resolves.toEqual({
      canonical: realpathSync(file),
    });
  });

  // 数据安全(codex 复查 P1):rm/lstat/rename-src 此前走 'read' 模式 → resolveForRead
  // realpath 跟随 symlink leaf,导致 rm 删的是链接「目标」数据而非链接本身,lstat 也
  // 失去「不跟随链接」语义(与 SDK 暴露的 lstat/isSymlink + 目录列表 symlink 标记矛盾)。
  // 改用「不跟随 leaf」解析:realpath 父目录 + 原 leaf,作用在链接本身。
  it('T1.a2 rm/lstat/rename-src 解析到链接本身而非 realpath 目标(不跟随 symlink leaf)', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();
    const target = join(root, 'target.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'precious');
    symlinkSync(target, link);
    registry.grant('com.test', [{ path: realpathSync(root), mode: 'rw' }]);

    const canonRoot = realpathSync(root);
    for (const op of ['remove', 'lstat', 'rename-src'] as const) {
      const r = await registry.check(token, 10, op, link, 'rw');
      expect('fullPath' in r).toBe(true);
      if ('fullPath' in r) {
        // 链接路径本身,而非 realpath 跟随后的 target
        expect(r.fullPath).toBe(join(canonRoot, 'link.txt'));
        expect(r.fullPath).not.toBe(realpathSync(target));
      }
    }
  });

  it('T1.a3 no-follow leaf 仍 realpath 父目录,经父级 .. 逃逸被 scope 拒', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();
    registry.grant('com.test', [{ path: realpathSync(root), mode: 'rw' }]);
    await expect(
      registry.check(token, 10, 'remove', join(root, '..', 'escape'), 'rw'),
    ).rejects.toThrow(ScopeError);
  });

  // 数据安全(codex 复查 P2):根目录 scope `/` 的前缀匹配 `probe.startsWith('/' + sep)`
  // 变成 startsWith('//') → 任何子路径都不命中,根目录授权后仍误拒/反复弹窗。check + covers
  // 都须把「scope 覆盖子树」对根目录也成立。
  it('T1.root 根目录 scope 覆盖任意子路径(check + covers)', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();
    const file = join(root, 'f.txt');
    writeFileSync(file, 'x');
    registry.grant('com.test', [{ path: '/', mode: 'rw' }]);

    // check 命中(不抛)
    await expect(
      registry.check(token, 10, 'read', file, 'rw'),
    ).resolves.toBeDefined();
    // covers 命中(同款前缀语义)
    expect(
      registry.covers('com.test', [{ path: realpathSync(file), mode: 'rw' }]),
    ).toBe(true);
  });

  it('T1.b check unknown token throws PluginIdentityError', async () => {
    const { registry } = makeHarness();

    await expect(
      registry.check('deadbeef', 10, 'read', '/tmp/x', 'r'),
    ).rejects.toThrow(PluginIdentityError);
  });

  it('T1.c check senderId mismatch throws PluginIdentityError', async () => {
    const { registry, token } = makeHarness();

    await expect(registry.check(token, 11, 'read', '/tmp/x', 'r')).rejects.toThrow(
      PluginIdentityError,
    );
  });

  it('T1.d check no scope granted throws ScopeError', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();
    const file = join(root, 'not-granted.txt');
    writeFileSync(file, 'ok');

    await expect(registry.check(token, 10, 'read', file, 'r')).rejects.toThrow(
      ScopeError,
    );
    await expect(registry.check(token, 10, 'read', file, 'r')).rejects.toThrow(
      'target not in any granted scope',
    );
  });

  it('T1.e check mode rw requires rw scope', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();

    registry.grant('com.test', [{ path: realpathSync(root), mode: 'r' }]);

    await expect(
      registry.check(token, 10, 'write', join(root, 'file.txt'), 'rw'),
    ).rejects.toThrow(ScopeError);
    await expect(
      registry.check(token, 10, 'write', join(root, 'file.txt'), 'rw'),
    ).rejects.toThrow('target not in any granted scope');
  });

  it('T1.f check write happy', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();
    const canonicalRoot = realpathSync(root);

    registry.grant('com.test', [{ path: canonicalRoot, mode: 'rw' }]);

    await expect(
      registry.check(token, 10, 'write', join(root, 'newfile.txt'), 'rw'),
    ).resolves.toEqual({
      parentCanonical: canonicalRoot,
      leaf: 'newfile.txt',
      fullPath: join(canonicalRoot, 'newfile.txt'),
    });
  });

  it('T1.f2 check scope 匹配单趟扫描,不调用 scopes.find', async () => {
    const { registry, token } = makeHarness();
    const root = makeTempDir();
    const canonicalRoot = realpathSync(root);
    const target = join(root, 'newfile.txt');
    registry.grant('com.test', [{ path: canonicalRoot, mode: 'rw' }]);
    const scopes = registry._peek('com.test') as PathScope[];
    const findSpy = vi.spyOn(scopes, 'find');

    try {
      await expect(registry.check(token, 10, 'write', target, 'rw')).resolves.toEqual({
        parentCanonical: canonicalRoot,
        leaf: 'newfile.txt',
        fullPath: join(canonicalRoot, 'newfile.txt'),
      });
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('T1.g check unknown opType throws ScopeError', async () => {
    const { registry, token } = makeHarness();

    await expect(
      registry.check(token, 10, 'banana' as never, '/x', 'r'),
    ).rejects.toThrow(ScopeError);
    await expect(
      registry.check(token, 10, 'banana' as never, '/x', 'r'),
    ).rejects.toThrow('unknown opType');
  });

  it('T1.h grant merge widens r to rw and emits scope-updated', () => {
    const { registry } = makeHarness();
    const listener = vi.fn<(event: ScopeUpdatedEvent) => void>();
    registry.on('scope-updated', listener);

    registry.grant('com.test', [{ path: '/tmp/p', mode: 'r' }]);
    registry.grant('com.test', [{ path: '/tmp/p', mode: 'rw' }]);

    expect(registry._peek('com.test')).toEqual([{ path: '/tmp/p', mode: 'rw' }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('T1.h2 grant merge 不通过 existing.map 分配 pairs 中间数组', () => {
    const { registry } = makeHarness();
    registry.grant('com.test', [
      { path: '/tmp/a', mode: 'r' },
      { path: '/tmp/b', mode: 'r' },
    ]);
    const existing = registry._peek('com.test') as PathScope[];
    const mapSpy = vi.spyOn(existing, 'map');

    try {
      registry.grant('com.test', [{ path: '/tmp/b', mode: 'rw' }]);

      expect(mapSpy).not.toHaveBeenCalled();
      expect(registry._peek('com.test')).toEqual([
        { path: '/tmp/a', mode: 'r' },
        { path: '/tmp/b', mode: 'rw' },
      ]);
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('T1.h3 mergeScopes 构造合并快照不通过 values spread 复制', () => {
    const source = readFileSync(
      join(__dirname, '../services/path-scope-registry.service.ts'),
      'utf8',
    );

    expect(source).not.toContain('[...byPath.values()]');
  });

  it('T1.i revokeAll emits scope-updated with empty scopes', () => {
    const { registry } = makeHarness();
    const listener = vi.fn<(event: ScopeUpdatedEvent) => void>();
    registry.on('scope-updated', listener);

    registry.grant('com.test', [{ path: '/tmp/p', mode: 'rw' }]);
    registry.revokeAll('com.test');

    expect(registry._peek('com.test')).toEqual([]);
    expect(listener).toHaveBeenLastCalledWith({
      pluginId: 'com.test',
      scopes: [],
    });
  });

  it('T2.a covers: exact path + 子树 命中,越界 / mode 收窄 不命中', () => {
    const { registry } = makeHarness();
    registry.grant('com.test', [{ path: '/ws/a', mode: 'rw' }]);

    // 同路径
    expect(registry.covers('com.test', [{ path: '/ws/a', mode: 'rw' }])).toBe(true);
    // 子树
    expect(
      registry.covers('com.test', [{ path: '/ws/a/b/c', mode: 'rw' }]),
    ).toBe(true);
    // rw 覆盖 r
    expect(registry.covers('com.test', [{ path: '/ws/a', mode: 'r' }])).toBe(true);
    // 越界(非子树前缀,/ws/ab 不应被 /ws/a 覆盖)
    expect(registry.covers('com.test', [{ path: '/ws/ab', mode: 'r' }])).toBe(
      false,
    );
    // 兄弟目录
    expect(registry.covers('com.test', [{ path: '/ws/x', mode: 'r' }])).toBe(
      false,
    );
  });

  it('T2.b covers: r scope 不覆盖 rw 请求;空注册表恒 false', () => {
    const { registry } = makeHarness();
    registry.grant('com.test', [{ path: '/ws/a', mode: 'r' }]);

    expect(registry.covers('com.test', [{ path: '/ws/a', mode: 'rw' }])).toBe(
      false,
    );
    expect(registry.covers('com.test', [{ path: '/ws/a', mode: 'r' }])).toBe(true);
    // 未授任何 scope 的 plugin
    expect(registry.covers('other', [{ path: '/ws/a', mode: 'r' }])).toBe(false);
  });

  it('T2.c covers: 多请求需全部命中', () => {
    const { registry } = makeHarness();
    registry.grant('com.test', [{ path: '/ws/a', mode: 'rw' }]);

    expect(
      registry.covers('com.test', [
        { path: '/ws/a/x', mode: 'rw' },
        { path: '/ws/a/y', mode: 'rw' },
      ]),
    ).toBe(true);
    expect(
      registry.covers('com.test', [
        { path: '/ws/a/x', mode: 'rw' },
        { path: '/ws/other', mode: 'rw' },
      ]),
    ).toBe(false);
  });

  it('T2.d covers 单趟显式扫描,不调用 requested.every / scopes.some', () => {
    const { registry } = makeHarness();
    registry.grant('com.test', [
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/b', mode: 'r' },
    ]);
    const scopes = registry._peek('com.test') as PathScope[];
    const requested = [
      { path: '/ws/a/x', mode: 'rw' },
      { path: '/ws/b/y', mode: 'r' },
    ] as PathScope[];
    const everySpy = vi.spyOn(requested, 'every');
    const someSpy = vi.spyOn(scopes, 'some');

    try {
      expect(registry.covers('com.test', requested)).toBe(true);
      expect(everySpy).not.toHaveBeenCalled();
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      everySpy.mockRestore();
      someSpy.mockRestore();
    }
  });

  it('T3.a hydrate 回填持久化 scope 且幂等、静默(不 emit)', () => {
    const { registry } = makeHarness();
    const listener = vi.fn<(event: ScopeUpdatedEvent) => void>();
    registry.on('scope-updated', listener);

    expect(registry.isHydrated('com.test')).toBe(false);
    registry.hydrate('com.test', [{ path: '/ws/a', mode: 'rw' }]);
    expect(registry.isHydrated('com.test')).toBe(true);
    expect(registry._peek('com.test')).toEqual([{ path: '/ws/a', mode: 'rw' }]);
    // 静默:水合是历史授权恢复,不应触发 scope-updated
    expect(listener).not.toHaveBeenCalled();

    // 幂等:第二次 hydrate(即便参数不同)不再改动
    registry.hydrate('com.test', [{ path: '/ws/b', mode: 'rw' }]);
    expect(registry._peek('com.test')).toEqual([{ path: '/ws/a', mode: 'rw' }]);
  });

  it('T3.b 空持久化也标记已水合(避免每请求打盘)', () => {
    const { registry } = makeHarness();
    registry.hydrate('com.test', []);
    expect(registry.isHydrated('com.test')).toBe(true);
    expect(registry._peek('com.test')).toEqual([]);
  });

  it('T3.c revokeAll 清除水合标记,允许重注册后重水合', () => {
    const { registry } = makeHarness();
    registry.hydrate('com.test', [{ path: '/ws/a', mode: 'rw' }]);
    registry.revokeAll('com.test');

    expect(registry.isHydrated('com.test')).toBe(false);
    registry.hydrate('com.test', [{ path: '/ws/b', mode: 'rw' }]);
    expect(registry._peek('com.test')).toEqual([{ path: '/ws/b', mode: 'rw' }]);
  });

  it('T3.d hydrate 后 grant 仍 emit 并与已水合 scope 合并', () => {
    const { registry } = makeHarness();
    const listener = vi.fn<(event: ScopeUpdatedEvent) => void>();
    registry.hydrate('com.test', [{ path: '/ws/a', mode: 'rw' }]);
    registry.on('scope-updated', listener);

    registry.grant('com.test', [{ path: '/ws/b', mode: 'rw' }]);
    expect(registry.getScopes('com.test')).toEqual([
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/b', mode: 'rw' },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
