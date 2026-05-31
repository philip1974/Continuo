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
});
