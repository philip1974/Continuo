import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryPermissionStore,
  ensureAuthorized,
  keepGrantedDecisions,
  replacePermissionDecisions,
  type PermissionDecision,
  type PermissionKey,
  type PermissionStore,
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
  it('keepGrantedDecisions 不通过 filter 重建 granted 子集', () => {
    const decisions: readonly PermissionDecision[] = [
      { permission: 'fs', granted: true, decidedAt: 1 },
      { permission: 'network', granted: false, decidedAt: 2 },
      { permission: 'shell', granted: true, decidedAt: 3 },
    ];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const kept = keepGrantedDecisions(decisions);
      const filterCallsDuringKeep = filterSpy.mock.calls.length;
      expect(kept.map((d) => d.permission)).toEqual(['fs', 'shell']);
      expect(keepGrantedDecisions.toString()).not.toContain('kept.push(');
      expect(filterCallsDuringKeep).toBe(0);
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('keepGrantedDecisions 空输入 / 全 denied 复用稳定空数组', () => {
    const deniedOnly: readonly PermissionDecision[] = [
      { permission: 'fs', granted: false, decidedAt: 1 },
    ];

    expect(keepGrantedDecisions([])).toEqual([]);
    expect(keepGrantedDecisions([])).toBe(keepGrantedDecisions([]));
    expect(keepGrantedDecisions(deniedOnly)).toBe(keepGrantedDecisions([]));
  });

  it('keepGrantedDecisions 全 granted 时复用原数组', () => {
    const decisions: PermissionDecision[] = [
      { permission: 'fs', granted: true, decidedAt: 1 },
      { permission: 'network', granted: true, decidedAt: 2 },
    ];

    expect(keepGrantedDecisions(decisions)).toBe(decisions);
  });

  it('keepGrantedDecisions 混合决策时只保留 granted 且返回新数组', () => {
    const decisions: PermissionDecision[] = [
      { permission: 'fs', granted: true, decidedAt: 1 },
      { permission: 'network', granted: false, decidedAt: 2 },
      { permission: 'shell', granted: true, decidedAt: 3 },
    ];

    const kept = keepGrantedDecisions(decisions);

    expect(kept).not.toBe(decisions);
    expect(kept).toEqual([
      { permission: 'fs', granted: true, decidedAt: 1 },
      { permission: 'shell', granted: true, decidedAt: 3 },
    ]);
  });

  it('replacePermissionDecisions 不通过 filter 移除被覆盖权限', () => {
    const decisions: readonly PermissionDecision[] = [
      { permission: 'fs', granted: true, decidedAt: 1 },
      { permission: 'network', granted: true, decidedAt: 2 },
      { permission: 'shell', granted: true, decidedAt: 3 },
    ];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const next = replacePermissionDecisions(decisions, ['fs', 'network'], false, 9);
      const filterCallsDuringReplace = filterSpy.mock.calls.length;
      expect(next).toMatchObject([
        { permission: 'shell', granted: true },
        { permission: 'fs', granted: false, decidedAt: 9 },
        { permission: 'network', granted: false, decidedAt: 9 },
      ]);
      expect(replacePermissionDecisions.toString()).not.toContain('next.push(');
      expect(filterCallsDuringReplace).toBe(0);
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('replacePermissionDecisions 空 perms 复用原决策列表', () => {
    const decisions: readonly PermissionDecision[] = [
      { permission: 'fs', granted: true, decidedAt: 1 },
    ];

    expect(replacePermissionDecisions(decisions, [], false, 9)).toBe(decisions);
  });

  it('未存过 → get 返空数组', async () => {
    const s = new InMemoryPermissionStore();
    const decisions = await s.get('p');
    expect(decisions).toEqual([]);
    await expect(s.get('other')).resolves.toBe(decisions);
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

  it('批量覆盖权限 → 不对传入 perms 逐条 includes 扫描旧决策', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs', 'network', 'shell', 'clipboard']);
    const perms: readonly PermissionKey[] = ['fs', 'network'];
    const includesSpy = vi.spyOn(Array.prototype, 'includes');

    try {
      await s.deny('p', perms);
      const callsOnInputPerms = includesSpy.mock.contexts.filter(
        (ctx) => ctx === perms,
      ).length;

      expect(callsOnInputPerms).toBe(0);
      expect(await s.get('p')).toMatchObject([
        { permission: 'shell', granted: true },
        { permission: 'clipboard', granted: true },
        { permission: 'fs', granted: false },
        { permission: 'network', granted: false },
      ]);
    } finally {
      includesSpy.mockRestore();
    }
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

describe('ensureAuthorized(v5 Phase 2 partial grant)', () => {
  it('requested 空 → ok,granted/denied 都空', async () => {
    const s = new InMemoryPermissionStore();
    const prompt = vi.fn();
    const r = await ensureAuthorized('p', [], s, prompt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual([]);
      expect(r.denied).toEqual([]);
      const again = await ensureAuthorized('p', [], s, prompt);
      expect(again.ok).toBe(true);
      if (again.ok) {
        expect(again.granted).toBe(r.granted);
        expect(again.denied).toBe(r.denied);
      }
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it('全部已 grant → ok,granted=requested,denied 空,不 prompt', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs', 'network']);
    const prompt = vi.fn();
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual(['fs', 'network']);
      expect(r.denied).toEqual([]);
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it('部分已 grant + 部分已 deny → ok partial(其中至少一项 granted)', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs']);
    await s.deny('p', ['network']);
    const prompt = vi.fn();
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual(['fs']);
      expect(r.denied).toEqual(['network']);
    }
    expect(prompt).not.toHaveBeenCalled(); // 都已决,不再问
  });

  it('已有 decisions → 单次遍历归类,不对 decisions 调 filter 两遍', async () => {
    const decisions: readonly PermissionDecision[] = [
      { permission: 'fs', granted: true, decidedAt: 1 },
      { permission: 'network', granted: false, decidedAt: 2 },
    ];
    const store: PermissionStore = {
      get: vi.fn(async () => decisions),
      grant: vi.fn(),
      deny: vi.fn(),
      clearDenied: vi.fn(),
    };
    const prompt = vi.fn();
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const r = await ensureAuthorized('p', ['fs', 'network'], store, prompt);
      const decisionFilterCalls = filterSpy.mock.contexts.filter(
        (ctx) => ctx === decisions,
      ).length;

      expect(decisionFilterCalls).toBe(0);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.granted).toEqual(['fs']);
        expect(r.denied).toEqual(['network']);
      }
      expect(ensureAuthorized.toString()).not.toContain('pending.push(');
      expect(ensureAuthorized.toString()).not.toContain('newDeny.push(');
      expect(ensureAuthorized.toString()).not.toContain('granted.push(');
      expect(ensureAuthorized.toString()).not.toContain('denied.push(');
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('requested 归类不通过 filter 多次重扫', async () => {
    const requested: readonly PermissionKey[] = ['fs', 'network'];
    const store: PermissionStore = {
      get: vi.fn(async () => [
        { permission: 'fs', granted: true, decidedAt: 1 },
        { permission: 'network', granted: false, decidedAt: 2 },
      ]),
      grant: vi.fn(),
      deny: vi.fn(),
      clearDenied: vi.fn(),
    };
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const r = await ensureAuthorized('p', requested, store, vi.fn());
      let requestedFilterCalls = 0;
      for (const ctx of filterSpy.mock.contexts) {
        if (ctx === requested) requestedFilterCalls++;
      }
      expect(requestedFilterCalls).toBe(0);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.granted).toEqual(['fs']);
        expect(r.denied).toEqual(['network']);
      }
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('全部已 deny → ok=false(plugin 不激活)', async () => {
    const s = new InMemoryPermissionStore();
    await s.deny('p', ['fs', 'network']);
    const prompt = vi.fn();
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.deniedPerms).toEqual(['fs', 'network']);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('待决调 prompt,用户全授 → ok,granted=requested', async () => {
    const s = new InMemoryPermissionStore();
    const prompt = vi.fn(async (
      _pid: string,
      perms: readonly PermissionKey[],
    ) => [...perms]);
    const r = await ensureAuthorized('p', ['fs', 'clipboard'], s, prompt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual(['fs', 'clipboard']);
      expect(r.denied).toEqual([]);
    }
    expect(prompt).toHaveBeenCalledWith('p', ['fs', 'clipboard']);
  });

  it('无历史 decisions 的首次授权走快路径,不预建 granted/denied Set', async () => {
    const store: PermissionStore = {
      get: vi.fn(async () => []),
      grant: vi.fn(),
      deny: vi.fn(),
      clearDenied: vi.fn(),
    };
    const prompt = vi.fn(async () => ['fs'] as PermissionKey[]);

    const r = await ensureAuthorized('p', ['fs', 'network'], store, prompt);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual(['fs']);
      expect(r.denied).toEqual(['network']);
    }
    expect(prompt).toHaveBeenCalledWith('p', ['fs', 'network']);
    expect(store.grant).toHaveBeenCalledWith('p', ['fs']);
    expect(store.deny).toHaveBeenCalledWith('p', ['network']);
    const src = readFileSync(
      path.join(process.cwd(), 'src/plugins/permissions.ts'),
      'utf-8',
    );
    expect(src.indexOf('decisions.length === 0')).toBeLessThan(
      src.indexOf('new Set<PermissionKey>()'),
    );
  });

  it('待决调 prompt,用户部分授 → ok partial,denied 列出未授项', async () => {
    const s = new InMemoryPermissionStore();
    const prompt = vi.fn(async (
      _pid: string,
      _perms: readonly PermissionKey[],
    ) => ['fs'] as PermissionKey[]); // 只授 fs,不授 network
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual(['fs']);
      expect(r.denied).toEqual(['network']);
    }
    // store 仍记录两条决策
    const decisions = await s.get('p');
    const fs = decisions.find((d) => d.permission === 'fs');
    const net = decisions.find((d) => d.permission === 'network');
    expect(fs?.granted).toBe(true);
    expect(net?.granted).toBe(false);
  });

  it('待决调 prompt,用户全拒 → ok=false', async () => {
    const s = new InMemoryPermissionStore();
    const prompt = vi.fn(async () => [] as PermissionKey[]);
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.deniedPerms).toEqual(['fs', 'network']);
  });

  it('部分已 grant + 部分待决 → 只 prompt 待决,合并结果', async () => {
    const s = new InMemoryPermissionStore();
    await s.grant('p', ['fs']);
    const prompt = vi.fn(async (
      _pid: string,
      perms: readonly PermissionKey[],
    ) => [...perms]);
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual(['fs', 'network']);
      expect(r.denied).toEqual([]);
    }
    expect(prompt).toHaveBeenCalledWith('p', ['network']);
  });

  it('已 deny 的项不被 prompt 复授(deny 是 sticky 的)', async () => {
    const s = new InMemoryPermissionStore();
    await s.deny('p', ['network']);
    const prompt = vi.fn(async () => ['fs'] as PermissionKey[]);
    const r = await ensureAuthorized('p', ['fs', 'network'], s, prompt);
    expect(prompt).toHaveBeenCalledWith('p', ['fs']); // network 不在 pending
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toEqual(['fs']);
      expect(r.denied).toEqual(['network']);
    }
  });
});
