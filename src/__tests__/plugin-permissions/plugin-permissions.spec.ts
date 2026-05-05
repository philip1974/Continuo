import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryPermissionStore,
  ensureAuthorized,
  type PermissionKey,
} from '../../plugins/permissions';
import { parseManifest } from '../../plugins/manifest';

describe('Manifest permissions schema', () => {
  it('manifest 不带 permissions → ok,permissions=undefined', () => {
    const r = parseManifest(
      JSON.stringify({ id: 'a.b', name: 'X', version: '1.0.0' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.permissions).toBeUndefined();
  });

  it('合法 permissions 数组 → ok', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        permissions: ['fs', 'network'],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.permissions).toEqual(['fs', 'network']);
  });

  it('permissions 含未知值 → SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        permissions: ['fs', 'evil'],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('permissions 空数组 → ok', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        permissions: [],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('InMemoryPermissionStore', () => {
  it('未存过 → get 返空数组', async () => {
    const s = new InMemoryPermissionStore();
    expect(await s.get('p')).toEqual([]);
  });

  it('grant + get 往返,decidedAt 在过去 100ms 内', async () => {
    const s = new InMemoryPermissionStore();
    const before = Date.now();
    await s.grant('p', ['fs']);
    const decisions = await s.get('p');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.permission).toBe('fs');
    expect(decisions[0]!.granted).toBe(true);
    expect(decisions[0]!.decidedAt).toBeGreaterThanOrEqual(before);
  });

  it('再次 grant 同一权限 → 覆盖(单条)', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs']);
    await s.grant('p', ['fs']);
    expect((await s.get('p')).length).toBe(1);
  });

  it('grant 后 deny 同一权限 → granted 翻 false', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs']);
    await s.deny('p', ['fs']);
    const d = await s.get('p');
    expect(d[0]!.granted).toBe(false);
  });

  it('clearDenied 移除该插件 granted=false 的决策,保留 granted=true', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs']);
    await s.deny('p', ['network', 'shell']);
    await s.clearDenied('p');
    const d = await s.get('p');
    expect(d).toHaveLength(1);
    expect(d[0]!.permission).toBe('fs');
    expect(d[0]!.granted).toBe(true);
  });

  it('clearDenied 不影响其它 plugin', async () => {
    const s = new InMemoryPermissionStore();
    await s.deny('p1', ['fs']);
    await s.deny('p2', ['network']);
    await s.clearDenied('p1');
    expect(await s.get('p1')).toEqual([]);
    expect(await s.get('p2')).toHaveLength(1);
  });

  it('clearDenied 未存过的 pluginId → noop', async () => {
    const s = new InMemoryPermissionStore();
    await s.clearDenied('nope');
    expect(await s.get('nope')).toEqual([]);
  });
});

describe('ensureAuthorized', () => {
  it('requested 空 → 直接 ok', async () => {
    const s = new InMemoryPermissionStore();
    const prompt = vi.fn();
    const r = await ensureAuthorized('p', [], s, prompt);
    expect(r.ok).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('全部已 grant → 直接 ok 不 prompt', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs', 'network']);
    const prompt = vi.fn();
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('任一已 deny → 直接 fail 不 prompt', async () => {
    const s = new InMemoryPermissionStore();
    await s.deny('p', ['shell']);
    const prompt = vi.fn();
    const r = await ensureAuthorized('p', ['fs', 'shell'], s, prompt);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.deniedPerms).toEqual(['shell']);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('待决调 prompt,用户全授 → grant + ok', async () => {
    const s = new InMemoryPermissionStore();
    const prompt = vi.fn(async (
      _pid: string,
      perms: readonly PermissionKey[],
    ) => [...perms]);
    const r = await ensureAuthorized('p', ['fs', 'clipboard'], s, prompt);
    expect(r.ok).toBe(true);
    expect(prompt).toHaveBeenCalledWith('p', ['fs', 'clipboard']);
    const decisions = await s.get('p');
    expect(decisions.every((d) => d.granted)).toBe(true);
  });

  it('待决调 prompt,用户部分拒 → 拒的部分 deny + fail', async () => {
    const s = new InMemoryPermissionStore();
    const prompt = vi.fn(async (
      _pid: string,
      _perms: readonly PermissionKey[],
    ) => ['fs'] as PermissionKey[]); // 只授 fs,不授 network
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.deniedPerms).toEqual(['network']);
    const decisions = await s.get('p');
    const fs = decisions.find((d) => d.permission === 'fs');
    const net = decisions.find((d) => d.permission === 'network');
    expect(fs?.granted).toBe(true);
    expect(net?.granted).toBe(false);
  });

  it('部分已 grant + 部分待决 → 只 prompt 待决', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs']);
    const prompt = vi.fn(async (
      _pid: string,
      perms: readonly PermissionKey[],
    ) => [...perms]);
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(true);
    expect(prompt).toHaveBeenCalledWith('p', ['network']);
  });
});
