import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginIdentityError, ScopeError } from '../../../src/plugins/types';
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
