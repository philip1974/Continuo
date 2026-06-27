// @vitest-environment jsdom
//
// P2 UI 一致性回归(第七 session R4 完整性批判):partial-grant warning
// (entry.warning「部分授权:已授 X;未授 Y」)只对 enabled+active 插件有意义。
// PluginsTab 行**无条件**渲染 p.warning(无 status 门控,见 PluginsTabContent.tsx:339)。
// activateEntry(311)在激活开头清 warning,但离开 active 的两条转换此前漏清:
//   - disableLocked:经 deactivateEntry(不碰 warning/error)后 status='disabled',
//     warning 残留 → 已禁用插件仍挂「⚠ 部分授权」陈旧标记。
//   - reloadLocked 失败:manifest 重解析失败 → status='failed' + error,warning 残留
//     → failed 插件同时显示 error 与陈旧 warning。
// 「对称清理缺口 / 防御只加在一条路径(activateEntry)漏平行转换」本仓高频类。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const coApiMocks = vi.hoisted(() => ({
  pluginFsRaw: {
    _registerPlugin: vi.fn().mockResolvedValue({ token: 't', generation: 1 }),
    _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('mock'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false }),
    lstat: vi.fn().mockResolvedValue({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false }),
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    cp: vi.fn().mockResolvedValue(undefined),
    readGitBlob: vi.fn().mockResolvedValue(new Uint8Array()),
    atomicReplaceWithinScope: vi.fn().mockResolvedValue(undefined),
    requestScope: vi.fn().mockResolvedValue('grant'),
    _scopeDecision: vi.fn().mockResolvedValue(undefined),
    onScopeRequest: vi.fn(() => () => {}),
    onScopeUpdated: vi.fn(() => () => {}),
  },
}));

vi.mock('@/lib/co-api', () => ({ coApi: { pluginFsRaw: coApiMocks.pluginFsRaw } }));

import { Plugin } from '../../plugins/Plugin';
import {
  PluginManager,
  type ManagerHost,
  type PluginDirInfo,
} from '../../plugins/PluginManager';
import { InMemoryPermissionStore } from '../../plugins/permissions';
import { createTestCoApp } from '../../plugins/test-utils';

const fakeApp = createTestCoApp('1.0.0');

class GoodPlugin extends Plugin {
  onload() {}
  onunload() {}
}

function manifestText(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, name: id, version: '0.1.0', ...extra });
}

// host:预存「fs 授权 + network 拒绝」→ activateEntry 走 partial grant 设 warning。
async function makePartialGrantManager(manifest: string): Promise<{
  mgr: PluginManager;
  state: { dirs: PluginDirInfo[] };
}> {
  const store = new InMemoryPermissionStore();
  await store.grant('p', ['fs']);
  await store.deny('p', ['network']);

  const state = {
    dirs: [{ id: 'p', manifestText: manifest, moduleUrl: 'mod://p' }] as PluginDirInfo[],
    enabled: new Set(['p']),
    modules: new Map<string, unknown>([['mod://p', { default: GoodPlugin }]]),
    enabledWritten: new Set<string>(),
  };
  const host: ManagerHost = {
    listPluginDirs: () => state.dirs,
    readEnabledIds: () => state.enabled,
    mutateEnabledId: (id, enabled) => {
      const next = new Set(state.enabled);
      if (enabled) next.add(id);
      else next.delete(id);
      state.enabled = next;
    },
    importModule: async (url) => {
      const m = state.modules.get(url);
      if (!m) throw new Error(`no module ${url}`);
      return m;
    },
    permissionStore: store,
    // 无 pending(fs/network 都已有决策),promptFn 不应被调用。
    promptFn: async () => [],
  };
  const mgr = new PluginManager(fakeApp, host);
  await mgr.init();
  return { mgr, state };
}

const PERMS = manifestText('p', { permissions: ['fs', 'network'] });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('49 · partial-grant warning 在离开 active 时被清', () => {
  it('前置:enabled partial-grant 插件确实带 warning(否则守卫无意义)', async () => {
    const { mgr } = await makePartialGrantManager(PERMS);
    const p = mgr.listAll().find((x) => x.id === 'p');
    expect(p?.status).toBe('enabled');
    expect(p?.warning).toBeTruthy();
  });

  it('disable 后 warning 被清(不再显示陈旧「部分授权」)', async () => {
    const { mgr } = await makePartialGrantManager(PERMS);
    await mgr.disable('p');
    const p = mgr.listAll().find((x) => x.id === 'p');
    expect(p?.status).toBe('disabled');
    expect(p?.warning).toBeUndefined();
  });

  it('reload 时 manifest 变非法 → failed,warning 被清(不与 error 并存)', async () => {
    const { mgr, state } = await makePartialGrantManager(PERMS);
    // 模拟用户把 manifest 改坏(version 缺失 → parseManifest 失败)。
    state.dirs[0] = {
      id: 'p',
      moduleUrl: 'mod://p',
      manifestText: JSON.stringify({ id: 'p', name: 'p' }),
    };
    await mgr.reload('p');
    const p = mgr.listAll().find((x) => x.id === 'p');
    expect(p?.status).toBe('failed');
    expect(p?.error).toBeTruthy();
    expect(p?.warning).toBeUndefined();
  });
});
