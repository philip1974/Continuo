// @vitest-environment jsdom
// renderer store ↔ 真实主进程设置存储 ↔ 真实磁盘(IPC 以 structuredClone 模拟)。见同目录 README。
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTempDirs } from '../_helpers/tmp-dir';
import { flushUserSettings, uninstallUserSettingsHost } from '../_helpers/fake-user-settings-main';
import type { ContinuoApi } from '../../../electron/preload';
import type { UserSettingsChanged, UserSettingsScopeState } from '../../../electron/shared/user-settings';

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

type Host = ContinuoApi['userSettings'];

const tmp = setupTempDirs();
const fileOf = (scope: 'settings' | 'keybindings'): string => path.join(h.dir, USER_SETTINGS_FILE_NAMES[scope]);
const readJson = async (scope: 'settings' | 'keybindings'): Promise<unknown> =>
  JSON.parse(await readFile(fileOf(scope), 'utf8'));

/** 一个窗口的 preload:调用真实 main 服务,出入参经 structuredClone(同 IPC),广播在 main 提交时同步派发。 */
function realHost(): Host {
  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return { ok: true as const, data: structuredClone(await fn()) };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false as const, code: e.code ?? 'IPC_HANDLER_ERROR', message: e.message ?? String(err) };
    }
  };
  return {
    snapshot: () => structuredClone(getUserSettingsSnapshot()),
    update: (scope, set, remove) => wrap(() => updateUserSettings(scope, structuredClone(set), [...remove])),
    importLegacy: (scope, record) => wrap(() => importUserSettings(scope, structuredClone(record))),
    onChanged: (cb: (p: UserSettingsChanged) => void) =>
      onUserSettingsChanged((scope, state: UserSettingsScopeState) => cb(structuredClone({ scope, ...state }))),
  };
}

/** 等 main 两个串行队列里已排队的写全部完成,再等 renderer 处理回复。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.all([updateUserSettings('settings', {}, []), updateUserSettings('keybindings', {}, [])]);
    await flushUserSettings();
  }
}

function installHost(host: Host = realHost()): Host {
  const w = globalThis as unknown as { window: { api?: Record<string, unknown> } };
  w.window.api = { ...(w.window.api ?? {}), userSettings: host };
  return host;
}

async function openValuesStore() {
  vi.resetModules();
  installHost();
  return import('../../plugins/settings/values-store');
}
async function openKeybindingsStore() {
  vi.resetModules();
  installHost();
  return import('../../plugins/keybindings/keybindings-store');
}

beforeEach(async () => {
  h.dir = await tmp.make('ui196-user-settings-rt-');
  _resetUserSettingsForTest();
  localStorage.clear();
});
afterEach(async () => {
  await settle();
  uninstallUserSettingsHost();
  vi.restoreAllMocks();
});

describe('改设置 / 快捷键后立即落盘', () => {
  it('setValue / reset:写调用一回复,磁盘文件就是新内容(之后强杀主进程不丢)', async () => {
    await loadUserSettings();
    const w = await openValuesStore();
    w.useSettingsValuesStore.getState().setValue('editor.fontSize', 20);
    await settle();
    expect(await readJson('settings')).toEqual({ 'editor.fontSize': 20 });
    w.useSettingsValuesStore.getState().reset('editor.fontSize');
    await settle();
    expect(await readJson('settings')).toEqual({});
  });

  it('setHotkey:写入 user-keybindings.json,不碰设置值文件', async () => {
    await loadUserSettings();
    const w = await openKeybindingsStore();
    w.useKeybindingsStore.getState().setHotkey('settings.toggle', 'mod+shift+y');
    await settle();
    expect(await readJson('keybindings')).toEqual({ 'settings.toggle': 'mod+shift+y' });
    await expect(readFile(fileOf('settings'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('「重启」:新进程读同一文件,store 首帧即为已存值', async () => {
    await writeFile(fileOf('settings'), JSON.stringify({ 'general.theme': 'light' }));
    await loadUserSettings();
    const w = await openValuesStore();
    expect(w.useSettingsValuesStore.getState().values).toEqual({ 'general.theme': 'light' });
  });

  it('超出文件上限 → main 拒写,本窗回滚到上次有效状态', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUserSettings();
    const w = await openValuesStore();
    const s = w.useSettingsValuesStore.getState();
    for (let i = 0; i < 33; i++) s.setValue(`big.${i}`, 'x'.repeat(64 * 1024));
    await settle();
    const values = w.useSettingsValuesStore.getState().values;
    expect(values).toEqual(getUserSettingsSnapshot().settings.record);
    expect(Object.keys(values).length).toBeLessThan(33);
    expect(await readJson('settings')).toEqual(values);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[settings] setValue 拒写'));
  });
});

describe('多窗口经 main 同步', () => {
  it('窗口 A 改 → 窗口 B 收到广播;两窗同时改不同 key 都保留', async () => {
    await loadUserSettings();
    const a = await openValuesStore();
    const b = await openValuesStore();
    a.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    b.useSettingsValuesStore.getState().setValue('editor.fontSize', 18);
    await settle();
    const merged = { 'general.theme': 'light', 'editor.fontSize': 18 };
    expect(a.useSettingsValuesStore.getState().values).toEqual(merged);
    expect(b.useSettingsValuesStore.getState().values).toEqual(merged);
    expect(await readJson('settings')).toEqual(merged);
  });
});

describe('一次性迁移旧 localStorage', () => {
  it('main 文件不存在 + 从未镜像过 + 旧 localStorage 有值 → 首帧即旧值,迁入文件(旧 id 一并迁移);旧 localStorage 仍是旧版本能读的值', async () => {
    const legacy = JSON.stringify({ 'general.theme': 'light', 'terminal.fontSize': 17 });
    localStorage.setItem('continuo.settings.values', legacy);
    localStorage.setItem('continuo.keybindings.overrides', JSON.stringify({ 'editor.save': '' }));
    await loadUserSettings();
    const w = await openValuesStore();
    expect(w.useSettingsValuesStore.getState().values).toEqual({
      'general.theme': 'light',
      'terminal.integrated.fontSize': 17,
    });
    const k = await openKeybindingsStore();
    expect(k.useKeybindingsStore.getState().overrides).toEqual({ 'editor.save': '' });
    await settle();
    expect(await readJson('settings')).toEqual({ 'general.theme': 'light', 'terminal.integrated.fontSize': 17 });
    expect(await readJson('keybindings')).toEqual({ 'editor.save': '' });
    expect(JSON.parse(localStorage.getItem('continuo.settings.values')!)).toEqual(JSON.parse(legacy)); // 降级回旧版本仍可读
    expect(getUserSettingsSnapshot().settings.needsImport).toBe(false);
  });

  it('从未镜像过(没有 .mirror 记录)且文件已存在 → 以文件为准,不从旧 localStorage 猜改动', async () => {
    await writeFile(fileOf('settings'), JSON.stringify({ 'general.theme': 'dark' }));
    localStorage.setItem('continuo.settings.values', JSON.stringify({ 'general.theme': 'light' }));
    await loadUserSettings();
    const w = await openValuesStore();
    expect(w.useSettingsValuesStore.getState().values).toEqual({ 'general.theme': 'dark' });
    await settle();
    expect(await readJson('settings')).toEqual({ 'general.theme': 'dark' });
  });

  it('两个窗口同时启动都去迁入 → 只迁一次,两窗收敛到文件', async () => {
    localStorage.setItem('continuo.settings.values', JSON.stringify({ 'editor.fontSize': 16 }));
    await loadUserSettings();
    const a = await openValuesStore();
    const b = await openValuesStore();
    a.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    await settle();
    expect(await readJson('settings')).toEqual({ 'editor.fontSize': 16, 'general.theme': 'light' });
    expect(b.useSettingsValuesStore.getState().values).toEqual({ 'editor.fontSize': 16, 'general.theme': 'light' });
  });

  it('损坏文件被隔离后不会再从旧 localStorage 迁入陈旧值', async () => {
    await writeFile(fileOf('settings'), JSON.stringify({ ok: 'kept', bad: { x: 1 } }));
    localStorage.setItem('continuo.settings.values', JSON.stringify({ stale: 'old' }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUserSettings();
    const w = await openValuesStore();
    await settle();
    expect(w.useSettingsValuesStore.getState().values).toEqual({ ok: 'kept' });
    expect(await readJson('settings')).toEqual({ ok: 'kept' });
  });
});

// 降级 / 再升级(见 README「旧版本兼容」):旧版本(0.2.15)只读写 localStorage 的旧键。
describe('旧版本兼容:镜像回旧 localStorage 键', () => {
  const VALUES = 'continuo.settings.values';
  const KEYS = 'continuo.keybindings.overrides';
  const legacyOf = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null');
  /** 「重启」新版本:main 重新读盘,renderer 重新建 store。 */
  async function restart() {
    await settle();
    _resetUserSettingsForTest();
    await loadUserSettings();
    return { values: await openValuesStore(), keys: await openKeybindingsStore() };
  }

  it('每次修改后旧键即是最新值(改过名的 id 写旧 id),降级后旧版本看得到新版改的设置', async () => {
    await loadUserSettings();
    const w = await openValuesStore();
    w.useSettingsValuesStore.getState().setValue('terminal.integrated.fontSize', 18);
    w.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    const k = await openKeybindingsStore();
    k.useKeybindingsStore.getState().setHotkey('settings.toggle', 'mod+shift+y');
    await settle();
    expect(legacyOf(VALUES)).toEqual({ 'terminal.fontSize': 18, 'general.theme': 'light' });
    expect(legacyOf(KEYS)).toEqual({ 'settings.toggle': 'mod+shift+y' });
    expect(await readJson('settings')).toEqual({ 'terminal.integrated.fontSize': 18, 'general.theme': 'light' });
  });

  it('降级期间旧版本改过 → 再升级时把它的改动(设 / 重置 / 旧 id)并进文件,新版独有的设置不丢', async () => {
    await loadUserSettings();
    const w = await openValuesStore();
    const s = w.useSettingsValuesStore.getState();
    s.setValue('terminal.integrated.fontSize', 18);
    s.setValue('editor.fontSize', 15);
    s.setValue('editor.wordWrap', 'on'); // 0.2.15 不认识的设置
    const k = await openKeybindingsStore();
    k.useKeybindingsStore.getState().setHotkey('settings.toggle', 'mod+shift+y');
    await settle();
    // 旧版本:读旧键、改、整份写回(不认识的条目原样保留),不碰 .mirror
    const old = legacyOf(VALUES) as Record<string, unknown>;
    old['terminal.fontSize'] = 20;
    delete old['editor.fontSize'];
    old['general.theme'] = 'light';
    localStorage.setItem(VALUES, JSON.stringify(old));
    localStorage.setItem(KEYS, JSON.stringify({ 'settings.toggle': 'mod+shift+u', 'editor.save': '' }));

    const r = await restart();
    const merged = { 'terminal.integrated.fontSize': 20, 'editor.wordWrap': 'on', 'general.theme': 'light' };
    expect(r.values.useSettingsValuesStore.getState().values).toEqual(merged);
    expect(r.keys.useKeybindingsStore.getState().overrides).toEqual({ 'settings.toggle': 'mod+shift+u', 'editor.save': '' });
    await settle();
    expect(await readJson('settings')).toEqual(merged);
    expect(await readJson('keybindings')).toEqual({ 'settings.toggle': 'mod+shift+u', 'editor.save': '' });

    // 并入后再重启:旧键与镜像一致,不再重复应用
    await restart();
    await settle();
    expect(await readJson('settings')).toEqual(merged);
  });

  it('旧版本没改过,只是新版在文件里改了 → 以文件为准(旧键不会把新值改回去)', async () => {
    await loadUserSettings();
    const w = await openValuesStore();
    w.useSettingsValuesStore.getState().setValue('editor.fontSize', 15);
    await settle();
    // 另一进程直接写文件(或镜像在强杀前没落盘):旧键 / 镜像仍是旧值、彼此一致
    await writeFile(fileOf('settings'), JSON.stringify({ 'editor.fontSize': 22 }));
    const r = await restart();
    expect(r.values.useSettingsValuesStore.getState().values).toEqual({ 'editor.fontSize': 22 });
    await settle();
    expect(legacyOf(VALUES)).toEqual({ 'editor.fontSize': 22 });
  });

  it('删掉 user-settings.json 后重启 = 恢复默认(VSCode 删 settings.json 同),不从旧 localStorage 回灌过时值', async () => {
    await loadUserSettings();
    const w = await openValuesStore();
    w.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    const k = await openKeybindingsStore();
    k.useKeybindingsStore.getState().setHotkey('settings.toggle', 'mod+shift+y');
    await settle();
    await rm(fileOf('settings'));
    await rm(fileOf('keybindings'));
    const r = await restart();
    expect(r.values.useSettingsValuesStore.getState().values).toEqual({});
    expect(r.keys.useKeybindingsStore.getState().overrides).toEqual({});
    await settle();
    expect(legacyOf(VALUES)).toEqual({}); // 降级后旧版本也是默认
    await expect(readFile(fileOf('settings'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('旧版本的改动恰好等于文件现值(main 无变化回复)→ 镜像照样跟上,不留下每次启动都要并入的差异', async () => {
    await loadUserSettings();
    const w = await openValuesStore();
    w.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    await settle();
    await writeFile(fileOf('settings'), JSON.stringify({ 'general.theme': 'dark' }));
    localStorage.setItem(VALUES, JSON.stringify({ 'general.theme': 'dark' }));
    await restart();
    await settle();
    expect(localStorage.getItem(`${VALUES}.mirror`)).toBe(localStorage.getItem(VALUES));
  });

  it('旧键整个不见了(旧版本当损坏清掉)不当成「全部重置」', async () => {
    await loadUserSettings();
    const w = await openValuesStore();
    w.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    await settle();
    localStorage.removeItem(VALUES);
    const r = await restart();
    expect(r.values.useSettingsValuesStore.getState().values).toEqual({ 'general.theme': 'light' });
  });
});

describe('收敛规则(createUserSettingsRecordOps)', () => {
  async function makeOps(host: Host) {
    vi.resetModules();
    installHost(host);
    const { createUserSettingsRecordOps } = await import('../../plugins/storage/user-settings-record');
    let mem: Record<string, string> = {};
    const notify = { error: vi.fn(), warn: vi.fn() };
    const ops = createUserSettingsRecordOps<string>({
      scope: 'keybindings',
      legacyKey: 'test.legacy',
      readOpts: { valueGuard: (v): v is string => typeof v === 'string', maxKeyLength: 256, maxEntries: 100 },
      getRecord: () => mem,
      setRecord: (next) => {
        mem = next;
      },
      tooLargeWarning: 'too large',
      saveFailedMessage: () => 'save failed',
      notSavedMessage: () => 'not saved',
      notify,
    });
    mem = ops.initial;
    return { ops, notify, mem: () => mem };
  }

  function controllableHost(snapshotOver: Partial<{ persistBlocked: boolean; record: Record<string, string> }> = {}) {
    const listeners = new Set<(p: UserSettingsChanged) => void>();
    const replies: Array<(s: UserSettingsScopeState) => void> = [];
    const host: Host = {
      snapshot: () => ({
        settings: { version: 1, record: {}, needsImport: false, persistBlocked: false },
        keybindings: {
          version: 1,
          record: snapshotOver.record ?? {},
          needsImport: false,
          persistBlocked: snapshotOver.persistBlocked ?? false,
        },
      }),
      update: () => new Promise((resolve) => replies.push((data) => resolve({ ok: true, data }))),
      importLegacy: () => Promise.resolve({ ok: true, data: { version: 1, record: {} } }),
      onChanged: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const broadcast = (version: number, record: Record<string, string>) => {
      for (const l of listeners) l({ scope: 'keybindings', version, record });
    };
    return { host, replies, broadcast };
  }

  it('快照 / 广播经 renderer 读端守卫(非法值丢弃)', async () => {
    const c = controllableHost({ record: { a: 'x', b: 1 as unknown as string } });
    const t = await makeOps(c.host);
    expect(t.mem()).toEqual({ a: 'x' });
  });

  it('乱序到达的旧版本广播被忽略', async () => {
    const c = controllableHost();
    const t = await makeOps(c.host);
    c.broadcast(5, { a: 'new' });
    expect(t.mem()).toEqual({ a: 'new' });
    c.broadcast(3, { a: 'old' });
    expect(t.mem()).toEqual({ a: 'new' });
  });

  it('本窗有未回复的写时,别窗广播不把乐观值改回去;写回复后收敛到最新权威状态', async () => {
    const c = controllableHost();
    const t = await makeOps(c.host);
    t.ops.setEntry('mine', 'mod+m');
    c.broadcast(2, { other: 'mod+o' }); // 别窗的提交(还不含我的值)
    expect(t.mem()).toEqual({ mine: 'mod+m' });
    c.replies[0]!({ version: 3, record: { other: 'mod+o', mine: 'mod+m' } });
    await flushUserSettings();
    expect(t.mem()).toEqual({ other: 'mod+o', mine: 'mod+m' });
  });

  it('读盘失败(persistBlocked)→ 第一次修改后提示一次「不会保存」', async () => {
    const c = controllableHost({ persistBlocked: true });
    const t = await makeOps(c.host);
    t.ops.setEntry('a', 'x');
    t.ops.setEntry('b', 'y');
    c.replies[0]!({ version: 2, record: { a: 'x' } });
    c.replies[1]!({ version: 3, record: { a: 'x', b: 'y' } });
    await flushUserSettings();
    expect(t.notify.warn).toHaveBeenCalledTimes(1);
    expect(t.notify.warn).toHaveBeenCalledWith('not saved', expect.any(String));
  });

  it('setEntry 对 `__proto__` 键写成自有属性', async () => {
    const c = controllableHost();
    const t = await makeOps(c.host);
    t.ops.setEntry('__proto__', 'x');
    expect(Object.hasOwn(t.mem(), '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(t.mem())).toBe(Object.prototype);
  });
});
