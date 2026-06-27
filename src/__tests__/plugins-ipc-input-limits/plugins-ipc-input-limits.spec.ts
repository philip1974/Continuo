// 边界(E16,E11-E15 同族):插件权限 IPC schema 加长度/数量上限。畸形 payload 可把
// _permissions.json / _path-scopes.json 写成超大对象/超长路径 → 主进程 RMW/atomic 写/水合/UI 卡顿。
// 超限 → zod 校验失败(safeHandle 走 BAD_INPUT)。cap 远超现实插件集合,不破坏正常写入。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  WriteEnabledInput,
  WritePermissionsInput,
  WritePluginPermissionsInput,
  InstallFromGitInput,
  UninstallInput,
} from '../../../electron/main/ipc/plugins.ipc';
import {
  clampGitUrl,
  GIT_URL_MAX,
} from '../../../electron/shared/plugins-channels';

describe('plugins IPC input limits (E16)', () => {
  it('正常 payload → ok', () => {
    expect(
      WriteEnabledInput.safeParse({ ids: ['a.b', 'c.d'] }).success,
    ).toBe(true);
    expect(
      WritePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: { decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }] },
      }).success,
    ).toBe(true);
    expect(
      WritePermissionsInput.safeParse({ data: { 'a.b': [] } }).success,
    ).toBe(true);
  });

  it('enabled ids 数量超 10000 → fail', () => {
    const ids = Array.from({ length: 10001 }, (_, i) => `p${i}`);
    expect(WriteEnabledInput.safeParse({ ids }).success).toBe(false);
  });

  it('plugin id 超 256 → fail', () => {
    expect(
      UninstallInput.safeParse({ id: 'x'.repeat(257) }).success,
    ).toBe(false);
    expect(
      WriteEnabledInput.safeParse({ ids: ['x'.repeat(257)] }).success,
    ).toBe(false);
  });

  it('decisions 数量超 1000 → fail', () => {
    const decisions = Array.from({ length: 1001 }, () => ({
      permission: 'fs',
      granted: true,
      decidedAt: 1,
    }));
    expect(
      WritePluginPermissionsInput.safeParse({ id: 'a.b', record: { decisions } })
        .success,
    ).toBe(false);
  });

  // 边界(E246):pathScopes 写端上限统一到 256(对齐读盘层 MAX_PERSISTED_SCOPES_PER_PLUGIN),
  // 此前 10_000 过松 → 写 257..10000 成功但读端只留前 256 静默丢。写端拒 >256,与读端对称。
  const makeScopes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `/p/${i}`, mode: 'r' as const }));
  it('E246 pathScopes 数量 257(超 256)→ fail(写读契约对称,不静默丢)', () => {
    expect(
      WritePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: { decisions: [], pathScopes: makeScopes(257) },
      }).success,
    ).toBe(false);
  });
  it('E246 pathScopes 数量 256(恰上限)→ pass', () => {
    expect(
      WritePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: { decisions: [], pathScopes: makeScopes(256) },
      }).success,
    ).toBe(true);
  });

  it('path scope 路径超 8192 → fail', () => {
    expect(
      WritePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: {
          decisions: [],
          pathScopes: [{ path: '/' + 'x'.repeat(8192), mode: 'r' }],
        },
      }).success,
    ).toBe(false);
  });

  it('permission record 条目数超 10000 → fail', () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < 10001; i++) data[`p${i}`] = [];
    expect(WritePermissionsInput.safeParse({ data }).success).toBe(false);
  });

  // 边界(E187,E185/E186 兄弟):data 改共享有界早停校验。补 pluginId key超长 / 非对象 data /
  // 非法 PermissionRecord value / 合规 data 用例。
  it('E187 pluginId key 超 256 → fail', () => {
    const data: Record<string, unknown> = { ['p'.repeat(257)]: [] };
    expect(WritePermissionsInput.safeParse({ data }).success).toBe(false);
  });
  it('E187 data 非对象(数组/字符串)→ fail', () => {
    expect(WritePermissionsInput.safeParse({ data: [] }).success).toBe(false);
    expect(WritePermissionsInput.safeParse({ data: 'x' }).success).toBe(false);
  });
  it('E187 value 非法 PermissionRecord → fail', () => {
    expect(
      WritePermissionsInput.safeParse({ data: { 'a.b': { bogus: 1 } } }).success,
    ).toBe(false);
    expect(
      WritePermissionsInput.safeParse({ data: { 'a.b': 'not-a-record' } })
        .success,
    ).toBe(false);
  });
  it('E187 合规 data(数组形态 + {decisions} 形态 + 空)→ ok', () => {
    expect(
      WritePermissionsInput.safeParse({
        data: {
          'a.b': [],
          'c.d': { decisions: [] },
        },
      }).success,
    ).toBe(true);
    expect(WritePermissionsInput.safeParse({ data: {} }).success).toBe(true);
  });

  it('git url 超 4096 → fail', () => {
    expect(
      InstallFromGitInput.safeParse({ url: 'https://' + 'x'.repeat(4096) })
        .success,
    ).toBe(false);
  });

  // 边界(E282):git URL 输入 renderer onChange 截断到 GIT_URL_MAX(防超长 paste 撑 React state + IPC
  // structured-clone 放大,main schema 才拒);两 Git URL 输入(Marketplace/PluginsTab)+ main schema 共用。
  describe('E282 git URL 长度收口', () => {
    it('clampGitUrl 超 GIT_URL_MAX → 截断,≤ 原样', () => {
      expect(clampGitUrl('https://x')).toBe('https://x');
      expect(clampGitUrl('x'.repeat(GIT_URL_MAX + 5000))).toHaveLength(
        GIT_URL_MAX,
      );
    });

    it('main schema 上限 = GIT_URL_MAX(同源,后门防线)', () => {
      // 恰好 GIT_URL_MAX 通过,+1 拒(证 schema .max 与 GIT_URL_MAX 一致)
      expect(
        InstallFromGitInput.safeParse({ url: 'x'.repeat(GIT_URL_MAX) }).success,
      ).toBe(true);
      expect(
        InstallFromGitInput.safeParse({ url: 'x'.repeat(GIT_URL_MAX + 1) })
          .success,
      ).toBe(false);
    });

    // 家族接线守卫:两个 Git URL 输入 onChange 都经 clampGitUrl(防某入口漏接/回归)。
    it.each([
      '../../../src/marketplace/MarketplaceTab.tsx',
      '../../../src/plugins/settings/PluginsTabContent.tsx',
    ])('%s 调用 clampGitUrl', (rel) => {
      const src = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), rel),
        'utf-8',
      );
      expect(src).toContain('clampGitUrl(');
    });
  });

  // 边界(E92,E87 读端对偶):decidedAt 必须有限非负。z.number() 接受 Infinity,但 JSON.stringify
  // 写成 null + 读盘层(E87)按有限数丢弃 → 写成功但重启静默丢(写读契约不对称)。
  it('E92 decidedAt = Infinity → fail(与读端有限校验对称)', () => {
    expect(
      WritePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: {
          decisions: [{ permission: 'fs', granted: true, decidedAt: Infinity }],
        },
      }).success,
    ).toBe(false);
  });

  it('E92 decidedAt 负数 → fail', () => {
    expect(
      WritePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: {
          decisions: [{ permission: 'fs', granted: true, decidedAt: -1 }],
        },
      }).success,
    ).toBe(false);
  });

  it('E92 decidedAt 有限非负 → ok', () => {
    expect(
      WritePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: {
          decisions: [{ permission: 'fs', granted: true, decidedAt: 123 }],
        },
      }).success,
    ).toBe(true);
  });
});
