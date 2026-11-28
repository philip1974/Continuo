// @vitest-environment node
// 主进程设置存储(electron/main/services/user-settings.service):真实磁盘读写。见同目录 README。
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTempDirs } from '../_helpers/tmp-dir';

const h = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => h.dir } }));

import {
  USER_SETTINGS_FILE_NAMES,
  _resetUserSettingsForTest,
  getUserSettingsSnapshot,
  importUserSettings,
  loadUserSettings,
  onUserSettingsChanged,
  updateUserSettings,
} from '../../../electron/main/services/user-settings.service';
import { USER_SETTINGS_ENTRIES_MAX, USER_SETTINGS_FILE_MAX_BYTES } from '../../../electron/shared/user-settings';

const tmp = setupTempDirs();
const fileOf = (scope: 'settings' | 'keybindings'): string => path.join(h.dir, USER_SETTINGS_FILE_NAMES[scope]);
const readJson = async (scope: 'settings' | 'keybindings'): Promise<unknown> =>
  JSON.parse(await readFile(fileOf(scope), 'utf8'));

beforeEach(async () => {
  h.dir = await tmp.make('ui196-user-settings-');
  _resetUserSettingsForTest();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('文件名', () => {
  it('不与 main 自己的 settings.json({version, locale})冲突;两类记录各一个文件', () => {
    expect(USER_SETTINGS_FILE_NAMES).toEqual({ settings: 'user-settings.json', keybindings: 'user-keybindings.json' });
  });
});

describe('读入', () => {
  it('缺文件 → 空记录,needsImport(首次启动新版本,待迁入旧 localStorage)', async () => {
    await loadUserSettings();
    const snap = getUserSettingsSnapshot();
    expect(snap.settings).toMatchObject({ record: {}, needsImport: true, persistBlocked: false });
    expect(snap.keybindings).toMatchObject({ record: {}, needsImport: true, persistBlocked: false });
  });

  it('已有文件 → 读入记录,不需要迁移', async () => {
    await writeFile(fileOf('settings'), JSON.stringify({ 'editor.fontSize': 18, 'general.theme': 'light' }));
    await loadUserSettings();
    expect(getUserSettingsSnapshot().settings).toMatchObject({
      record: { 'editor.fontSize': 18, 'general.theme': 'light' },
      needsImport: false,
    });
  });

  it('JSON 损坏 → 原文件隔离为 .corrupt 留证,写回空记录(之后照常写盘,也不再迁入旧值)', async () => {
    await writeFile(fileOf('settings'), '{oops');
    await loadUserSettings();
    expect(await readFile(`${fileOf('settings')}.corrupt`, 'utf8')).toBe('{oops');
    expect(await readJson('settings')).toEqual({});
    expect(getUserSettingsSnapshot().settings).toMatchObject({ record: {}, needsImport: false, persistBlocked: false });
    await updateUserSettings('settings', { 'editor.fontSize': 15 }, []);
    expect(await readJson('settings')).toEqual({ 'editor.fontSize': 15 });
  });

  it('部分条目非法 → 隔离原文件,抢救合法条目并立即写回', async () => {
    const raw = JSON.stringify({ ok: 'x', n: 3, obj: { a: 1 }, arr: [1], nul: null, b: true });
    await writeFile(fileOf('keybindings'), raw);
    await loadUserSettings();
    expect(await readFile(`${fileOf('keybindings')}.corrupt`, 'utf8')).toBe(raw);
    expect(await readJson('keybindings')).toEqual({ ok: 'x', n: 3, b: true });
    expect(getUserSettingsSnapshot().keybindings.record).toEqual({ ok: 'x', n: 3, b: true });
  });

  it('非对象(数组)→ 损坏,隔离并写回空记录', async () => {
    await writeFile(fileOf('settings'), '[1,2]');
    await loadUserSettings();
    expect(await readFile(`${fileOf('settings')}.corrupt`, 'utf8')).toBe('[1,2]');
    expect(await readJson('settings')).toEqual({});
  });

  it('超大文件 → 不读内容,整体隔离并写回空记录', async () => {
    await writeFile(fileOf('settings'), `{"a":"${'x'.repeat(USER_SETTINGS_FILE_MAX_BYTES)}"}`);
    await loadUserSettings();
    expect((await readdir(h.dir)).filter((n) => n.startsWith('user-settings.json.corrupt'))).toHaveLength(1);
    expect(await readJson('settings')).toEqual({});
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '读不出来(权限 / IO)→ 按空记录、persistBlocked,修改只留在内存、绝不覆盖原文件',
    async () => {
      const original = JSON.stringify({ 'editor.fontSize': 20 });
      await writeFile(fileOf('settings'), original);
      await chmod(fileOf('settings'), 0o000);
      try {
        await loadUserSettings();
        expect(getUserSettingsSnapshot().settings).toMatchObject({ record: {}, needsImport: false, persistBlocked: true });
        const r = await updateUserSettings('settings', { 'general.theme': 'light' }, []);
        expect(r.record).toEqual({ 'general.theme': 'light' });
        // 迁移也不接受(文件存在、内容未知)
        const imported = await importUserSettings('settings', { 'editor.fontSize': 12 });
        expect(imported.record).toEqual({ 'general.theme': 'light' });
      } finally {
        await chmod(fileOf('settings'), 0o600);
      }
      expect(await readFile(fileOf('settings'), 'utf8')).toBe(original);
    },
  );
});

describe('修改:立即原子写盘', () => {
  it('update 返回时文件已是新内容(之后进程被强杀也不丢);删 key 同样立即写盘', async () => {
    await loadUserSettings();
    const r1 = await updateUserSettings('settings', { 'editor.fontSize': 18 }, []);
    expect(await readJson('settings')).toEqual({ 'editor.fontSize': 18 });
    expect(r1.record).toEqual({ 'editor.fontSize': 18 });
    await updateUserSettings('settings', { 'general.theme': 'light' }, ['editor.fontSize']);
    expect(await readJson('settings')).toEqual({ 'general.theme': 'light' });
    // 不留临时文件
    expect((await readdir(h.dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('无变化 → 不写盘、不升版本、不通知', async () => {
    await loadUserSettings();
    await updateUserSettings('settings', { a: 1 }, []);
    const v = getUserSettingsSnapshot().settings.version;
    const listener = vi.fn();
    onUserSettingsChanged(listener);
    await writeFile(fileOf('settings'), JSON.stringify({ a: 1, marker: true })); // 若写盘会被覆盖
    const r = await updateUserSettings('settings', { a: 1 }, ['missing']);
    expect(r.version).toBe(v);
    expect(listener).not.toHaveBeenCalled();
    expect(await readJson('settings')).toEqual({ a: 1, marker: true });
  });

  it('并发的增量修改(多个窗口改不同 key)串行合并,一个都不丢;版本单调,每次提交通知一次', async () => {
    await loadUserSettings();
    const seen: number[] = [];
    onUserSettingsChanged((scope, s) => {
      if (scope === 'settings') seen.push(s.version);
    });
    await Promise.all([
      updateUserSettings('settings', { a: 1 }, []),
      updateUserSettings('settings', { b: 2 }, []),
      updateUserSettings('settings', { c: 3 }, []),
    ]);
    expect(await readJson('settings')).toEqual({ a: 1, b: 2, c: 3 });
    expect(seen).toHaveLength(3);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
  });

  it('两类记录互不影响', async () => {
    await loadUserSettings();
    await updateUserSettings('keybindings', { 'editor.save': 'mod+shift+s' }, []);
    expect(await readJson('keybindings')).toEqual({ 'editor.save': 'mod+shift+s' });
    await expect(readFile(fileOf('settings'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('`__proto__` 键写成自有属性并原样落盘', async () => {
    await loadUserSettings();
    const r = await updateUserSettings('settings', JSON.parse('{"__proto__":"x"}') as Record<string, string>, []);
    expect(Object.hasOwn(r.record, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(r.record)).toBe(Object.prototype);
    expect(await readFile(fileOf('settings'), 'utf8')).toContain('"__proto__": "x"');
  });

  it('超条目上限 → 拒写(PAYLOAD_TOO_LARGE),记录与文件不变', async () => {
    const full: Record<string, number> = {};
    for (let i = 0; i < USER_SETTINGS_ENTRIES_MAX; i++) full[`k${i}`] = i;
    await writeFile(fileOf('settings'), JSON.stringify(full));
    await loadUserSettings();
    await expect(updateUserSettings('settings', { extra: 1 }, [])).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(Object.keys(getUserSettingsSnapshot().settings.record)).toHaveLength(USER_SETTINGS_ENTRIES_MAX);
  });

  it('超文件字节上限 → 拒写(PAYLOAD_TOO_LARGE),记录与文件不变', async () => {
    await loadUserSettings();
    await updateUserSettings('settings', { keep: 1 }, []);
    const big: Record<string, string> = {};
    for (let i = 0; i < 40; i++) big[`t${i}`] = 'y'.repeat(60 * 1024);
    await expect(updateUserSettings('settings', big, [])).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(getUserSettingsSnapshot().settings.record).toEqual({ keep: 1 });
    expect(await readJson('settings')).toEqual({ keep: 1 });
  });

  it('写盘失败 → 抛错,记录不变(renderer 回滚)', async () => {
    await loadUserSettings();
    await updateUserSettings('settings', { keep: 1 }, []);
    // 目录不可写:临时文件建不出来
    await chmod(h.dir, 0o500);
    try {
      await expect(updateUserSettings('settings', { other: 2 }, [])).rejects.toBeTruthy();
    } finally {
      await chmod(h.dir, 0o700);
    }
    expect(getUserSettingsSnapshot().settings.record).toEqual({ keep: 1 });
    expect(await readJson('settings')).toEqual({ keep: 1 });
  });
});

describe('一次性迁移(IMPORT)', () => {
  it('文件原本不存在 → 迁入并立即写盘;之后不再需要迁移', async () => {
    await loadUserSettings();
    await importUserSettings('settings', { 'editor.fontSize': 16 });
    expect(await readJson('settings')).toEqual({ 'editor.fontSize': 16 });
    expect(getUserSettingsSnapshot().settings.needsImport).toBe(false);
  });

  it('第二个窗口再迁入 / 文件已存在 / 迁入前已有修改 → 不接受,只认文件', async () => {
    await loadUserSettings();
    await importUserSettings('settings', { a: 1 });
    const r = await importUserSettings('settings', { a: 2, b: 3 });
    expect(r.record).toEqual({ a: 1 });

    await updateUserSettings('keybindings', { x: 'mod+x' }, []);
    const k = await importUserSettings('keybindings', { y: 'mod+y' });
    expect(k.record).toEqual({ x: 'mod+x' });
    expect(await readJson('keybindings')).toEqual({ x: 'mod+x' });
  });

  it('已有文件 → 不接受迁入', async () => {
    await writeFile(fileOf('settings'), JSON.stringify({ a: 1 }));
    await loadUserSettings();
    const r = await importUserSettings('settings', { a: 2 });
    expect(r.record).toEqual({ a: 1 });
  });

  it('空记录不算迁移(仍可由别的窗口迁入)', async () => {
    await loadUserSettings();
    await importUserSettings('settings', {});
    expect(getUserSettingsSnapshot().settings.needsImport).toBe(true);
  });
});
