// 设置值 / 快捷键覆盖存在主进程文件,每次修改立即原子写盘(对齐 VSCode settings.json / keybindings.json)。
// 此前存在 renderer localStorage:Chromium 延迟数秒才刷盘,改后 1.3s / 3.5s 强杀主进程均丢失(第 64 轮 B 组第 4 项)。
// BDD: src/__tests__/user-settings-main-store/
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { dispatchModKey } from './helpers/hotkeys';
import { EDITOR_TAB, SETTINGS_NAV, openSettingsTab, settingNumberInput } from './helpers/settings';
import {
  USER_KEYBINDINGS_FILE,
  USER_SETTINGS_FILE,
  killMainProcess,
  readUserSettingsFile,
  removeUserSettingsFiles,
} from './helpers/user-settings-file';

// 远小于 Chromium 把 localStorage 刷到磁盘的数秒延迟(修复前此时强杀必丢),对主进程的一次原子写绰绰有余。
const KILL_AFTER_MS = 500;

let ud = '';
const apps: ElectronApplication[] = [];

test.beforeEach(() => {
  ud = mkdtempSync(path.join(tmpdir(), 'continuo-durable-'));
});
test.afterEach(async () => {
  for (const app of apps.splice(0)) await killMainProcess(app).catch(() => undefined);
  rmSync(ud, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

async function launchReady(): Promise<{ app: ElectronApplication; win: Page }> {
  const r = await launch();
  await waitForAppReady(r.win);
  await waitForTestHooks(r.win);
  return r;
}

async function close(app: ElectronApplication): Promise<void> {
  await app.close();
  apps.splice(apps.indexOf(app), 1);
}

test('设置页改字号 + 改主题后立即 kill -9 主进程 → 重启后都保留,首帧即亮色', async () => {
  test.setTimeout(90_000);
  const first = await launchReady();
  await openSettingsTab(first.win, EDITOR_TAB);
  await settingNumberInput(first.win, 'editor.fontSize').fill('21');
  await first.win.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.theme', 'light'));
  await first.win.waitForTimeout(KILL_AFTER_MS);
  await killMainProcess(first.app);

  expect(readUserSettingsFile(ud)).toMatchObject({ 'editor.fontSize': 21, 'general.theme': 'light' });

  const second = await launch();
  // 首帧(入口模块在 React 之前)就按主进程快照里的主题去掉 dark class
  expect(await second.win.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
  await waitForAppReady(second.win);
  await waitForTestHooks(second.win);
  expect(await second.win.evaluate(() => globalThis.__continuoTest!.getSettingValue('editor.fontSize'))).toBe(21);
  expect(await second.win.evaluate(() => globalThis.__continuoTest!.getSettingValue('general.theme'))).toBe('light');
  await close(second.app);
});

test('改快捷键后立即 kill -9 主进程 → 重启后新组合仍触发', async () => {
  test.setTimeout(90_000);
  const first = await launchReady();
  await first.win.evaluate(() => globalThis.__continuoTest!.setHotkey('settings.toggle', 'mod+shift+y'));
  await first.win.waitForTimeout(KILL_AFTER_MS);
  await killMainProcess(first.app);

  expect(readUserSettingsFile(ud, USER_KEYBINDINGS_FILE)).toEqual({ 'settings.toggle': 'mod+shift+y' });

  const second = await launchReady();
  await dispatchModKey(second.win, 'y', { shift: true });
  await expect(second.win.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({ timeout: 10_000 });
  await close(second.app);
});

test('两个窗口经主进程同步;两窗同时改不同设置都保留', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launchReady();
  const next = app.waitForEvent('window');
  await win.evaluate(() => globalThis.__continuoTest!.executeCommand('window.new'));
  const win2 = await next;
  await win2.waitForLoadState('domcontentloaded');
  await waitForAppReady(win2);
  await waitForTestHooks(win2);

  await win.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.fontSize', 19));
  await expect.poll(() => win2.evaluate(() => globalThis.__continuoTest!.getSettingValue('editor.fontSize'))).toBe(19);

  await Promise.all([
    win.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.tabSize', 6)),
    win2.evaluate(() => globalThis.__continuoTest!.setSettingValue('autoSave.delayMs', 1700)),
  ]);
  const both = { 'editor.fontSize': 19, 'editor.tabSize': 6, 'autoSave.delayMs': 1700 };
  await expect.poll(() => readUserSettingsFile(ud)).toMatchObject(both);
  for (const page of [win, win2]) {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const t = globalThis.__continuoTest!;
          return [t.getSettingValue('editor.fontSize'), t.getSettingValue('editor.tabSize'), t.getSettingValue('autoSave.delayMs')];
        }),
      )
      .toEqual([19, 6, 1700]);
  }
  await close(app);
});

test('旧版本 userData(只有 localStorage)→ 首次启动迁入;之后镜像回旧键,降级期间旧版本的改动再升级时并入;删掉文件 = 恢复默认', async () => {
  test.setTimeout(120_000);
  // 造一个「旧版本」的 userData:localStorage 里有设置值(含旧 id)与快捷键,主进程文件还不存在。
  const legacySettings = JSON.stringify({ 'general.theme': 'light', 'terminal.fontSize': 17 });
  const first = await launchReady();
  await first.win.evaluate(
    ([s, k]) => {
      localStorage.setItem('continuo.settings.values', s);
      localStorage.setItem('continuo.keybindings.overrides', k);
    },
    [legacySettings, JSON.stringify({ 'settings.toggle': 'mod+shift+u' })] as const,
  );
  await close(first.app);
  removeUserSettingsFiles(ud);

  const second = await launch();
  // 迁移过程中首帧也正确(读旧 localStorage)
  expect(await second.win.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
  await waitForAppReady(second.win);
  await waitForTestHooks(second.win);
  expect(await second.win.evaluate(() => globalThis.__continuoTest!.getSettingValue('terminal.integrated.fontSize'))).toBe(17);
  await expect.poll(() => readUserSettingsFile(ud)).toEqual({ 'general.theme': 'light', 'terminal.integrated.fontSize': 17 });
  await expect.poll(() => readUserSettingsFile(ud, USER_KEYBINDINGS_FILE)).toEqual({ 'settings.toggle': 'mod+shift+u' });
  await dispatchModKey(second.win, 'u', { shift: true });
  await expect(second.win.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({ timeout: 10_000 });
  // 旧键是权威记录的镜像(旧 id),降级回旧版本看到的就是它
  await expect
    .poll(() => second.win.evaluate(() => JSON.parse(localStorage.getItem('continuo.settings.values') ?? 'null')))
    .toEqual(JSON.parse(legacySettings));
  // 模拟降级期间旧版本改了设置(它整份写回旧键,不碰 .mirror)
  await second.win.evaluate(() =>
    localStorage.setItem(
      'continuo.settings.values',
      JSON.stringify({ 'general.theme': 'dark', 'terminal.fontSize': 17, 'editor.fontSize': 30 }),
    ),
  );
  await close(second.app);

  const third = await launchReady();
  expect(await third.win.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  expect(await third.win.evaluate(() => globalThis.__continuoTest!.getSettingValue('editor.fontSize'))).toBe(30);
  await expect
    .poll(() => readUserSettingsFile(ud))
    .toEqual({ 'general.theme': 'dark', 'terminal.integrated.fontSize': 17, 'editor.fontSize': 30 });
  await close(third.app);

  // 删掉设置文件 = 恢复默认(VSCode 删 settings.json 同),不从旧 localStorage 回灌
  removeUserSettingsFiles(ud);
  const fourth = await launchReady();
  expect(await fourth.win.evaluate(() => globalThis.__continuoTest!.getSettingValue('editor.fontSize'))).toBeUndefined();
  expect(readUserSettingsFile(ud)).toBeNull();
  await close(fourth.app);
});

test('设置文件损坏 → 隔离为 .corrupt 留证,应用照常启动、之后的修改照常写盘', async () => {
  test.setTimeout(90_000);
  mkdirSync(ud, { recursive: true });
  writeFileSync(path.join(ud, USER_SETTINGS_FILE), '{"editor.fontSize": 18, oops');
  writeFileSync(path.join(ud, USER_KEYBINDINGS_FILE), JSON.stringify({ 'settings.toggle': 'mod+shift+j', bad: { x: 1 } }));
  const { app, win } = await launchReady();
  expect(readFileSync(path.join(ud, `${USER_SETTINGS_FILE}.corrupt`), 'utf8')).toBe('{"editor.fontSize": 18, oops');
  expect(readUserSettingsFile(ud)).toEqual({});
  // 快捷键文件里合法的条目被抢救出来
  expect(readUserSettingsFile(ud, USER_KEYBINDINGS_FILE)).toEqual({ 'settings.toggle': 'mod+shift+j' });
  await dispatchModKey(win, 'j', { shift: true });
  await expect(win.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({ timeout: 10_000 });

  await win.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.fontSize', 16));
  await expect.poll(() => readUserSettingsFile(ud)).toEqual({ 'editor.fontSize': 16 });
  await close(app);
});
