// 插件授权按权限项增量合并(终审 P1:陈旧窗口保存不得覆盖别窗的撤销)。见同目录 README.md。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutatePluginPermissions,
  readPermissions,
} from '../../../electron/main/services/plugins.service';

const ID = 'com.x.p';
let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'continuo-perm-merge-'));
  await mkdir(path.join(baseDir, ID)); // 插件已安装
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function seed(data: unknown): Promise<void> {
  await writeFile(path.join(baseDir, '_permissions.json'), JSON.stringify(data), 'utf-8');
}

function byPerm(record: unknown): Record<string, boolean> {
  const decisions = Array.isArray(record)
    ? record
    : (record as { decisions: unknown[] }).decisions;
  const out: Record<string, boolean> = {};
  for (const d of decisions as { permission: string; granted: boolean }[]) {
    out[d.permission] = d.granted;
  }
  return out;
}

describe('main:mutatePluginPermissions 按权限项合并当前落盘记录', () => {
  it('A 撤销 shell 后,B(缓存仍认为 shell 已授)保存 network → shell 仍为拒绝', async () => {
    await seed({
      [ID]: [
        { permission: 'shell', granted: true, decidedAt: 1 },
        { permission: 'fs', granted: true, decidedAt: 1 },
      ],
    });
    // 窗口 A:撤销 shell
    await mutatePluginPermissions(baseDir, ID, { kind: 'set', perms: ['shell'], granted: false });
    // 窗口 B:只提交它改动的权限项,不带陈旧的整条记录
    const merged = await mutatePluginPermissions(baseDir, ID, {
      kind: 'set',
      perms: ['network'],
      granted: true,
    });

    expect(byPerm(merged)).toEqual({ shell: false, fs: true, network: true });
    expect(byPerm((await readPermissions(baseDir))[ID])).toEqual({
      shell: false,
      fs: true,
      network: true,
    });
  });

  it('set 只替换指定项的决策,decidedAt 取 main 当前时间;保留 pathScopes 与其它插件', async () => {
    await seed({
      [ID]: {
        decisions: [{ permission: 'fs', granted: false, decidedAt: 1 }],
        pathScopes: [{ path: '/tmp/x', mode: 'rw' }],
      },
      'com.other': [{ permission: 'shell', granted: true, decidedAt: 1 }],
    });
    const before = Date.now();
    const merged = await mutatePluginPermissions(baseDir, ID, {
      kind: 'set',
      perms: ['fs'],
      granted: true,
    });

    expect(merged).toEqual({
      decisions: [{ permission: 'fs', granted: true, decidedAt: expect.any(Number) }],
      pathScopes: [{ path: '/tmp/x', mode: 'rw' }],
    });
    const decidedAt = (merged as unknown as { decisions: { decidedAt: number }[] }).decisions[0]!.decidedAt;
    expect(decidedAt).toBeGreaterThanOrEqual(before);
    const all = await readPermissions(baseDir);
    expect(all[ID]).toEqual(merged);
    expect(all['com.other']).toEqual([{ permission: 'shell', granted: true, decidedAt: 1 }]);
  });

  it('clear-denied 只去掉拒绝项(以落盘为准),保留已授项与 pathScopes', async () => {
    await seed({
      [ID]: {
        decisions: [
          { permission: 'fs', granted: true, decidedAt: 1 },
          { permission: 'shell', granted: false, decidedAt: 2 },
        ],
        pathScopes: [{ path: '/tmp/x', mode: 'r' }],
      },
    });
    const merged = await mutatePluginPermissions(baseDir, ID, { kind: 'clear-denied' });
    expect(merged).toEqual({
      decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }],
      pathScopes: [{ path: '/tmp/x', mode: 'r' }],
    });
    expect((await readPermissions(baseDir))[ID]).toEqual(merged);
  });

  it('clear-denied 后既无决策也无 pathScopes → 删除条目并返回 null', async () => {
    await seed({ [ID]: [{ permission: 'shell', granted: false, decidedAt: 2 }] });
    await expect(
      mutatePluginPermissions(baseDir, ID, { kind: 'clear-denied' }),
    ).resolves.toBeNull();
    expect(await readPermissions(baseDir)).toEqual({});
  });

  it('无授权记录的插件 clear-denied → null,不创建条目', async () => {
    await expect(
      mutatePluginPermissions(baseDir, ID, { kind: 'clear-denied' }),
    ).resolves.toBeNull();
    expect(await readPermissions(baseDir)).toEqual({});
  });

  it('并发增量变更同一插件 → 全部累积(串行写链内读最新落盘)', async () => {
    await Promise.all([
      mutatePluginPermissions(baseDir, ID, { kind: 'set', perms: ['fs'], granted: true }),
      mutatePluginPermissions(baseDir, ID, { kind: 'set', perms: ['shell'], granted: false }),
      mutatePluginPermissions(baseDir, ID, { kind: 'set', perms: ['network'], granted: true }),
    ]);
    expect(byPerm((await readPermissions(baseDir))[ID])).toEqual({
      fs: true,
      shell: false,
      network: true,
    });
  });

  // 终审 P1:窗口 B 的旧授权弹窗在插件被 A 卸载后点「授权」→ 不得写回已卸载插件的授权(同 id 重装会继承)。
  it('插件目录不存在(已卸载)→ 拒绝写入 NOT_INSTALLED,_permissions.json 不变', async () => {
    await rm(path.join(baseDir, ID), { recursive: true, force: true });
    await seed({ 'com.other': [{ permission: 'shell', granted: true, decidedAt: 1 }] });
    await expect(
      mutatePluginPermissions(baseDir, ID, { kind: 'set', perms: ['shell'], granted: true }),
    ).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    await expect(
      mutatePluginPermissions(baseDir, ID, { kind: 'clear-denied' }),
    ).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    expect(await readPermissions(baseDir)).toEqual({
      'com.other': [{ permission: 'shell', granted: true, decidedAt: 1 }],
    });
  });
});
