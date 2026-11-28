// 重启恢复窗口几何与焦点(VSCode 同):主窗位置 / 尺寸 / 最大化;popout 子窗位置尺寸不漂移、不抢主窗焦点;
// 重启后焦点在活动编辑器,可直接键入。BDD: src/__tests__/window-state-restore/
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { DOCK_POPOUT, openWorkspaceFile } from './helpers/editor';
import { SETTINGS } from './helpers/settings';
import { readPersistedExplorer } from './helpers/persisted-explorer';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let userData = '';
let workspace = '';
let app: ElectronApplication | null = null;

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-winstate-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-winstate-ws-'));
  writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1;\n');
  seedExplorerJson(userData, { root: workspace });
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
  rmSync(userData, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const a = await launchContinuo(userData);
  app = a;
  const main = await a.firstWindow();
  await expect(main.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 15_000 });
  return { app: a, main };
}

async function quit(a: ElectronApplication): Promise<void> {
  await a.close();
  app = null;
}

/** 主显示器工作区内一个明显不同于默认居中的矩形。 */
async function targetRect(a: ElectronApplication): Promise<Rect> {
  return await a.evaluate(({ screen }) => {
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      x: wa.x + 37,
      y: wa.y + 41,
      width: Math.min(1000, wa.width - 100),
      height: Math.min(640, wa.height - 100),
    };
  });
}

/** 主窗(非 popout)的 BrowserWindow 状态。 */
async function mainWindowState(a: ElectronApplication) {
  return await a.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('popout=1'))!;
    return { bounds: w.getNormalBounds(), isMaximized: w.isMaximized(), focused: w.isFocused() };
  });
}

test('主窗位置 / 尺寸重启后恢复,并写进 explorer.json 的 windowState', async () => {
  test.setTimeout(90_000);
  let { app: a } = await launch();
  const rect = await targetRect(a);
  await a.evaluate(({ BrowserWindow }, r) => {
    BrowserWindow.getAllWindows()[0]!.setBounds(r);
  }, rect);
  await quit(a);

  const persisted = readPersistedExplorer(userData) as {
    windows: Array<{ windowSeq: number; windowState?: { bounds: Rect } }>;
  };
  expect(persisted.windows.find((w) => w.windowSeq === 0)?.windowState?.bounds).toEqual(rect);

  ({ app: a } = await launch());
  expect((await mainWindowState(a)).bounds).toEqual(rect);
});

test('主窗最大化重启后恢复最大化,还原后回到之前的普通矩形', async () => {
  test.setTimeout(90_000);
  let { app: a } = await launch();
  const rect = await targetRect(a);
  await a.evaluate(({ BrowserWindow }, r) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setBounds(r);
    w.maximize();
  }, rect);
  await expect.poll(async () => (await mainWindowState(a)).isMaximized).toBe(true);
  await quit(a);

  ({ app: a } = await launch());
  await expect.poll(async () => (await mainWindowState(a)).isMaximized).toBe(true);
  expect((await mainWindowState(a)).bounds).toEqual(rect);
});

test('popout 子窗位置 / 尺寸重启两次不漂移;恢复出来的子窗不抢主窗焦点', async () => {
  test.setTimeout(150_000);
  let { app: a, main } = await launch();
  // 主窗不在屏幕原点:原实现每次重启子窗往右下漂主窗原点的距离
  const mainRect = await targetRect(a);
  await a.evaluate(({ BrowserWindow }, r) => {
    BrowserWindow.getAllWindows()[0]!.setBounds(r);
  }, mainRect);
  await main.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);
  const popoutContent = await a.evaluate(({ BrowserWindow, screen }) => {
    const wa = screen.getPrimaryDisplay().workArea;
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'))!;
    const content = { x: wa.x + 300, y: wa.y + 120, width: 640, height: 480 };
    w.setContentBounds(content);
    return w.getContentBounds();
  });
  // 等应用记下子窗新位置再退出(同下方用例「等编辑器会话落盘」):弹出后 dockview 等子窗 load 才挂上组,主进程挪窗后子窗
  // renderer 的 screenX/Y 也是异步更新 —— 立即退出存下的是弹出前 / 挪动前的状态(人不会在几十 ms 内弹出、挪窗再退出)。
  await expect
    .poll(
      () => {
        const persisted = JSON.parse(readFileSync(path.join(userData, 'explorer.json'), 'utf8')) as {
          windows?: Array<{ windowSeq: number; layout?: { popoutGroups?: Array<{ position?: { left?: number; width?: number; height?: number } }> } }>;
        };
        const pos = persisted.windows?.find((w) => w.windowSeq === 0)?.layout?.popoutGroups?.[0]?.position;
        return pos ? { left: pos.left, width: pos.width, height: pos.height } : null;
      },
      { timeout: 10_000 },
    )
    .toEqual({ left: popoutContent.x, width: popoutContent.width, height: popoutContent.height });

  const popoutState = () =>
    a.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'));
      return w ? { content: w.getContentBounds(), focused: w.isFocused(), visible: w.isVisible() } : null;
    });

  for (let restart = 0; restart < 2; restart += 1) {
    await quit(a);
    ({ app: a, main } = await launch());
    await expect.poll(popoutState, { timeout: 15_000 }).not.toBeNull();
    await expect.poll(async () => (await popoutState())?.content, { timeout: 10_000 }).toEqual(popoutContent);
    const p = (await popoutState())!;
    expect(p.visible).toBe(true);
    expect(p.focused).toBe(false);
    expect((await mainWindowState(a)).focused).toBe(true);
  }
});

// 只移动、不改尺寸(没有 resize 事件兜底):popout 位置靠 main 推送的子窗 move 得知(不再每帧轮询),移动后位置照常落盘、
// 重启回到移动后的位置。BDD: src/__tests__/popout-window-move/
test('popout 子窗只移动不改尺寸:新位置落盘,重启后回到该位置', async () => {
  test.setTimeout(120_000);
  let { app: a, main } = await launch();
  await main.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);
  const persistedLeft = () => {
    const persisted = readPersistedExplorer(userData) as {
      windows?: Array<{ windowSeq: number; layout?: { popoutGroups?: Array<{ position?: { left?: number } }> } }>;
    };
    return persisted.windows?.find((w) => w.windowSeq === 0)?.layout?.popoutGroups?.[0]?.position?.left ?? null;
  };
  // 等弹出后的布局先落盘(之后再挪,确保落盘的新值来自移动)
  await expect.poll(persistedLeft, { timeout: 10_000 }).not.toBeNull();
  const moved = await a.evaluate(({ BrowserWindow, screen }) => {
    const wa = screen.getPrimaryDisplay().workArea;
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'))!;
    const before = w.getContentBounds();
    const x = before.x === wa.x + 211 ? wa.x + 157 : wa.x + 211;
    w.setPosition(x + (w.getBounds().x - before.x), w.getBounds().y);
    const after = w.getContentBounds();
    return { x: after.x, width: after.width, height: after.height, sameSize: after.width === before.width && after.height === before.height };
  });
  expect(moved.sameSize).toBe(true);
  await expect.poll(persistedLeft, { timeout: 10_000 }).toBe(moved.x);

  await quit(a);
  ({ app: a, main } = await launch());
  await expect
    .poll(
      () =>
        a.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'));
          return w ? w.getContentBounds().x : null;
        }),
      { timeout: 15_000 },
    )
    .toBe(moved.x);
});

// 第六十九轮 A 组审计:popout 最大化 / 全屏时退出,重启恢复成铺满屏幕的普通窗口、原尺寸丢失。VSCode 辅助窗口存 bounds + mode。
// BDD: src/__tests__/window-state-restore/popout-window-mode.spec.ts
for (const mode of ['maximized', 'fullscreen'] as const) {
  test(`popout 子窗${mode === 'maximized' ? '最大化' : '全屏'}时退出:重启恢复该状态,还原后回到原来的普通尺寸`, async () => {
    test.setTimeout(150_000);
    let { app: a, main } = await launch();
    await main.getByRole('button', { name: DOCK_POPOUT }).click();
    await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);
    const normal = await a.evaluate(({ BrowserWindow, screen }) => {
      const wa = screen.getPrimaryDisplay().workArea;
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'))!;
      w.setContentBounds({ x: wa.x + 260, y: wa.y + 110, width: 620, height: 460 });
      return w.getContentBounds();
    });
    type Persisted = {
      windows?: Array<{
        windowSeq: number;
        popoutWindowModes?: Array<{ mode: string }>;
        layout?: { popoutGroups?: Array<{ position?: { left?: number; width?: number; height?: number }; windowMode?: unknown }> };
      }>;
    };
    const persistedPos = (file: unknown) => {
      const pos = (file as Persisted).windows?.find((w) => w.windowSeq === 0)?.layout?.popoutGroups?.[0]?.position;
      return pos ? { left: pos.left, width: pos.width, height: pos.height } : null;
    };
    const normalPos = { left: normal.x, width: normal.width, height: normal.height };
    await expect.poll(() => persistedPos(readPersistedExplorer(userData)), { timeout: 10_000 }).toEqual(normalPos);

    const popout = () =>
      a.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'));
        return w ? { maximized: w.isMaximized(), fullscreen: w.isFullScreen(), content: w.getContentBounds() } : null;
      });
    const enter = (m: typeof mode) =>
      a.evaluate(({ BrowserWindow }, m) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'))!;
        if (m === 'maximized') w.maximize();
        else w.setFullScreen(true);
      }, m);
    const inMode = async () => {
      const p = await popout();
      return p ? (mode === 'maximized' ? p.maximized : p.fullscreen) : null;
    };
    await enter(mode);
    await expect.poll(inMode, { timeout: 10_000 }).toBe(true);
    // 状态进旁挂文件;explorer.json(0.2.15 读的)布局里仍是普通矩形、不带 windowMode
    await expect
      .poll(() => (readPersistedExplorer(userData) as Persisted).windows?.find((w) => w.windowSeq === 0)?.popoutWindowModes?.[0]?.mode, {
        timeout: 10_000,
      })
      .toBe(mode);
    const legacy = JSON.parse(readFileSync(path.join(userData, 'explorer.json'), 'utf8')) as Persisted;
    expect(persistedPos(legacy)).toEqual(normalPos);
    const legacyEntry = legacy.windows?.find((w) => w.windowSeq === 0);
    expect(legacyEntry?.popoutWindowModes).toBeUndefined();
    expect(legacyEntry?.layout?.popoutGroups?.[0]?.windowMode).toBeUndefined();

    await quit(a);
    ({ app: a, main } = await launch());
    await expect.poll(inMode, { timeout: 20_000 }).toBe(true);
    // 还原 → 回到原来的普通尺寸
    await a.evaluate(({ BrowserWindow }, m) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1'))!;
      if (m === 'maximized') w.unmaximize();
      else w.setFullScreen(false);
    }, mode);
    await expect.poll(inMode, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await popout())?.content, { timeout: 10_000 }).toEqual(normal);
    // 还原后再退出:普通状态落盘(不再带最大化 / 全屏)
    await expect
      .poll(() => (readPersistedExplorer(userData) as Persisted).windows?.find((w) => w.windowSeq === 0)?.popoutWindowModes ?? null, {
        timeout: 10_000,
      })
      .toBeNull();
  });
}

// 第七十轮 A 组审计:两个位置尺寸相同的 popout 只最大化其一,重启后最大化套到了另一个上(恢复时只按矩形认领)。修后按恢复开窗
// 次序认领(第 N 次开窗 = popoutGroups[N])。BDD: src/__tests__/window-state-restore/popout-window-mode.spec.ts
test('两个位置尺寸相同的 popout 只最大化其一:重启后仍是那一个最大化,另一个保持普通', async () => {
  test.setTimeout(150_000);
  let { app: a, main } = await launch();
  await openWorkspaceFile(main, ['a.ts']);
  await expect(main.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  // 先弹出设置(popoutGroups[0]),再弹出编辑器组(popoutGroups[1])
  await main.getByRole('button', { name: SETTINGS }).click();
  await main.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);
  await main.locator('.cm-content').click();
  await main.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(3);

  /** 各 popout 子窗:是否编辑器那个(DOM 里有 .cm-content)、最大化、内容矩形。 */
  const popouts = () =>
    a.evaluate(async ({ BrowserWindow }) => {
      const out: Array<{ editor: boolean; maximized: boolean; content: Electron.Rectangle }> = [];
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.getURL().includes('popout=1')) continue;
        const editor = (await w.webContents.executeJavaScript("!!document.querySelector('.cm-content')")) as boolean;
        out.push({ editor, maximized: w.isMaximized(), content: w.getContentBounds() });
      }
      return out.sort((x, y) => Number(x.editor) - Number(y.editor));
    });
  const same = await a.evaluate(({ BrowserWindow, screen }) => {
    const wa = screen.getPrimaryDisplay().workArea;
    const rect = { x: wa.x + 260, y: wa.y + 110, width: 620, height: 460 };
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('popout=1')) w.setContentBounds(rect);
    return rect;
  });
  await expect.poll(async () => (await popouts()).map((p) => p.editor), { timeout: 10_000 }).toEqual([false, true]);
  type Persisted = {
    windows?: Array<{
      windowSeq: number;
      popoutWindowModes?: Array<{ id: string; mode: string }>;
      layout?: { popoutGroups?: Array<{ position?: { left?: number; top?: number; width?: number; height?: number } }> };
    }>;
  };
  const entry = () => (readPersistedExplorer(userData) as Persisted).windows?.find((w) => w.windowSeq === 0);
  // 两个组落盘的位置尺寸相同
  await expect
    .poll(
      () => {
        const groups = entry()?.layout?.popoutGroups ?? [];
        return groups.length === 2 && JSON.stringify(groups[0]!.position) === JSON.stringify(groups[1]!.position);
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // 只最大化编辑器那个(popoutGroups[1])
  await a.evaluate(async ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.getURL().includes('popout=1')) continue;
      if ((await w.webContents.executeJavaScript("!!document.querySelector('.cm-content')")) as boolean) w.maximize();
    }
  });
  await expect.poll(async () => (await popouts()).map((p) => p.maximized), { timeout: 10_000 }).toEqual([false, true]);
  await expect.poll(() => entry()?.popoutWindowModes?.length ?? 0, { timeout: 10_000 }).toBe(1);

  await quit(a);
  ({ app: a, main } = await launch());
  await expect.poll(() => a.windows().length, { timeout: 20_000 }).toBe(3);
  await expect.poll(async () => (await popouts()).map((p) => p.editor), { timeout: 15_000 }).toEqual([false, true]);
  await expect.poll(async () => (await popouts()).map((p) => p.maximized), { timeout: 15_000 }).toEqual([false, true]);
  // 普通的那个仍是原来的矩形
  expect((await popouts())[0]!.content).toEqual(same);
});

test('设置面板弹出到 popout 后重启:主窗标题栏 / 窗口标题 / 状态栏取主窗的活动编辑器(不是 popout 里的面板)', async () => {
  test.setTimeout(120_000);
  let { app: a, main } = await launch();
  await openWorkspaceFile(main, ['a.ts']);
  await expect(main.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  await main.getByRole('button', { name: SETTINGS }).click();
  const titleBar = () => main.locator('header').first();
  const settingsTitle = /设置|Settings|설정/;
  await expect(titleBar()).toContainText(settingsTitle);
  await main.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);
  // 等含 popout 的布局落盘(弹出后 dockview 等子窗 load 才挂上组)
  await expect
    .poll(
      () => {
        const persisted = JSON.parse(readFileSync(path.join(userData, 'explorer.json'), 'utf8')) as {
          windows?: Array<{ windowSeq: number; layout?: { popoutGroups?: unknown[] } }>;
        };
        return persisted.windows?.find((w) => w.windowSeq === 0)?.layout?.popoutGroups?.length ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  await quit(a);

  ({ app: a, main } = await launch());
  await expect.poll(() => a.windows().length, { timeout: 15_000 }).toBe(2);
  await expect(main.locator('.cm-content')).toContainText('export const a', { timeout: 15_000 });
  await expect(titleBar()).toContainText('a.ts', { timeout: 10_000 });
  await expect(titleBar()).not.toContainText(settingsTitle);
  await expect(main.locator('footer[data-statusbar]')).toContainText('a.ts');
  await expect.poll(() => main.title()).toContain('a.ts');
});

test('重启后焦点在活动编辑器,可直接键入', async () => {
  test.setTimeout(90_000);
  let { app: a, main } = await launch();
  await openWorkspaceFile(main, ['a.ts']);
  await expect(main.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  // 等编辑器会话落盘
  await expect
    .poll(() => readFileSync(path.join(userData, 'explorer.json'), 'utf8').includes('a.ts'), { timeout: 10_000 })
    .toBe(true);
  await quit(a);

  ({ app: a, main } = await launch());
  await expect(main.locator('.cm-content')).toContainText('export const a', { timeout: 15_000 });
  await expect(main.locator('.cm-content')).toBeFocused({ timeout: 10_000 });
  await main.keyboard.type('// typed ');
  await expect(main.locator('.cm-content')).toContainText('// typed');
  // 有未保存改动:退出时不弹确认框
  await a.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  });
});
