// 插件 id `constructor` 合法(plugin-id 只拒 `.`/`_` 开头),但 main 端授权表是普通对象:此前
// `{...readPermissions()}['constructor']` 命中 Object 构造函数 → `.decisions.filter` 抛错,授权流程失败;
// readPluginPathScopes 返回 Object 函数而非数组。查表须只认自有属性。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mutatePluginPermissions,
  readPermissions,
  readPluginPathScopes,
  removePluginPermissions,
  writePluginPathScopes,
} from '../../../electron/main/services/plugins.service';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lm-proto-perm-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('插件 id 为 Object.prototype 成员名:main 授权流程', () => {
  it('id=constructor(唯一满足 plugin-id 小写形态的原型成员名)首次授权 → 成功落盘并返回合并记录', async () => {
    const id = 'constructor';
    mkdirSync(join(tmp, id));
    const rec = await mutatePluginPermissions(tmp, id, {
      kind: 'set',
      perms: ['fs'],
      granted: true,
    });
    expect(rec).toEqual([expect.objectContaining({ permission: 'fs', granted: true })]);
    const all = await readPermissions(tmp);
    expect(Object.hasOwn(all, id)).toBe(true);
  });

  it('id=constructor 首次 clear-denied → 无记录,返回 null 且不触盘', async () => {
    mkdirSync(join(tmp, 'constructor'));
    const rec = await mutatePluginPermissions(tmp, 'constructor', { kind: 'clear-denied' });
    expect(rec).toBeNull();
    expect(existsSync(join(tmp, '_permissions.json'))).toBe(false);
  });

  it('id=constructor removePluginPermissions:无条目不触盘;有条目 → 删除', async () => {
    await removePluginPermissions(tmp, 'constructor');
    expect(existsSync(join(tmp, '_permissions.json'))).toBe(false);

    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({ constructor: [{ permission: 'fs', granted: true, decidedAt: 1 }] }),
    );
    expect(Object.hasOwn(await readPermissions(tmp), 'constructor')).toBe(true);
    await removePluginPermissions(tmp, 'constructor');
    expect(Object.hasOwn(await readPermissions(tmp), 'constructor')).toBe(false);
  });

  it('id=constructor 无持久化 path scope → readPluginPathScopes 返回空数组', async () => {
    await writePluginPathScopes(tmp, 'other', [{ path: tmp, mode: 'r' }]);
    expect(await readPluginPathScopes(tmp, 'constructor')).toEqual([]);
  });

  it('id=constructor 清空不存在的 path scope → 不触盘', async () => {
    await writePluginPathScopes(tmp, 'constructor', []);
    expect(existsSync(join(tmp, '_plugin-path-scopes.json'))).toBe(false);
  });
});
