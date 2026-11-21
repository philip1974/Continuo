import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readPermissions,
  uninstallPlugin,
  writePluginPermissions,
} from '../services/plugins.service';

// 数据安全(独立审计揪出的同族遗漏入口):uninstallPlugin 清 _permissions.json 此前手写
// readPermissions → delete → writePermissions(整表写),绕过 permissionsWriteChain —— 与紧邻的
// _enabled.json 清理(已改走 setEnabledId 入链)是同一个反模式,只修了兄弟。另一窗口同时给**别的**
// 插件 grant/deny 时,卸载用旧快照整表写回 → 抹掉刚落盘的授权(跨窗口 lost update)。
// 修复:卸载改走 writePluginPermissions(id, [])(链内 RMW,空记录 = 删除该 id 条目)。
describe('uninstallPlugin 清 permissions 走 permissionsWriteChain', () => {
  let baseDir: string;
  const decision = (permission: string) => ({ permission, granted: true, decidedAt: 1 });

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'continuo-uninstall-perms-'));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('卸载 b 与并发给 a 授权 → a 的授权不丢,b 的条目被清', async () => {
    await mkdir(path.join(baseDir, 'b'));
    await writeFile(
      path.join(baseDir, '_permissions.json'),
      JSON.stringify({ b: [decision('fs')] }),
      'utf-8',
    );

    await Promise.all([
      uninstallPlugin(baseDir, 'b'),
      writePluginPermissions(baseDir, 'a', [decision('fs')]),
    ]);

    const perms = await readPermissions(baseDir);
    expect(Object.keys(perms)).toEqual(['a']);
  });

  it('多轮交错仍不丢(卸载在前/在后发起都成立)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const victim = `v${round}`;
      const keeper = `k${round}`;
      await mkdir(path.join(baseDir, victim));
      await writePluginPermissions(baseDir, victim, [decision('fs')]);
      const ops = [
        uninstallPlugin(baseDir, victim),
        writePluginPermissions(baseDir, keeper, [decision('fs')]),
      ];
      await Promise.all(round % 2 === 0 ? ops : ops.reverse());
      const perms = await readPermissions(baseDir);
      expect(victim in perms).toBe(false);
      expect(keeper in perms).toBe(true);
    }
  });
});
