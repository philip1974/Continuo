// 边界(E16,E11-E15 同族):插件权限 IPC schema 加长度/数量上限。畸形 payload 可把
// _permissions.json / _plugin-path-scopes.json 写成超大对象/超长路径 → 主进程 RMW/atomic 写/水合/UI 卡顿。
// 超限 → zod 校验失败(safeHandle 走 BAD_INPUT)。cap 远超现实插件集合,不破坏正常写入。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  MutatePluginPermissionsInput,
  InstallFromGitInput,
  ReadMainByDirInput,
  UninstallInput,
} from '../../../electron/main/ipc/plugins.ipc';
import {
  clampGitUrl,
  GIT_URL_MAX,
} from '../../../electron/shared/plugins-channels';

describe('plugins IPC input limits (E16)', () => {
  it('正常 payload → ok', () => {
    expect(
      MutatePluginPermissionsInput.safeParse({
        id: 'a.b',
        mutation: { kind: 'set', perms: ['fs'], granted: true },
      }).success,
    ).toBe(true);
  });

  it('READ_MAIN_BY_DIR:dir 必填且 ≤255、manifestHash 必为 64 位小写 hex、拒绝多余字段', () => {
    const h = 'a'.repeat(64);
    expect(ReadMainByDirInput.safeParse({ dir: 'a.b', manifestHash: h }).success).toBe(true);
    expect(ReadMainByDirInput.safeParse({ dir: 'a.b' }).success).toBe(false);
    expect(ReadMainByDirInput.safeParse({ dir: '', manifestHash: h }).success).toBe(false);
    expect(ReadMainByDirInput.safeParse({ dir: 'x'.repeat(256), manifestHash: h }).success).toBe(false);
    expect(ReadMainByDirInput.safeParse({ dir: 'a', manifestHash: 'a'.repeat(65) }).success).toBe(false);
    expect(ReadMainByDirInput.safeParse({ dir: 'a', manifestHash: 'G'.repeat(64) }).success).toBe(false);
    expect(ReadMainByDirInput.safeParse({ dir: 'a', manifestHash: h, extra: 1 }).success).toBe(false);
  });

  it('plugin id 超 256 → fail', () => {
    expect(
      UninstallInput.safeParse({ id: 'x'.repeat(257) }).success,
    ).toBe(false);
  });

  it('授权变更 perms 数量超过权限枚举大小 → fail', () => {
    expect(
      MutatePluginPermissionsInput.safeParse({
        id: 'a.b',
        mutation: { kind: 'set', perms: Array.from({ length: 100 }, () => 'fs'), granted: true },
      }).success,
    ).toBe(false);
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

  // 边界(E92 演进):授权记录不再经 IPC 整条写入,decidedAt 由 main 取当前时间,renderer 不能再传。
  it('授权变更不接受 renderer 自带 decidedAt / 整条 record', () => {
    expect(
      MutatePluginPermissionsInput.safeParse({
        id: 'a.b',
        mutation: { kind: 'set', perms: ['fs'], granted: true, decidedAt: Infinity },
      }).success,
    ).toBe(false);
    expect(
      MutatePluginPermissionsInput.safeParse({
        id: 'a.b',
        record: { decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }] },
      }).success,
    ).toBe(false);
  });
});
