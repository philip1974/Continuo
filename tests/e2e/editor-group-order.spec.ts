// 编辑器组按空间顺序编号(对齐 VSCode GroupsOrder.GRID_APPEARANCE):拖动 dock tab 换位后 dock 标题「编辑器 N」、⌘1/⌘2/⌘3、
// 读屏名称里的组号都跟位置走,重启保留;重启恢复的 popout 子窗关掉后,回到主窗的组重新编号、不与第一组重名。
// BDD: src/__tests__/editor-groups/(editor-groups-order.spec.tsx)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { DOCK_POPOUT } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { readPersistedExplorer } from './helpers/persisted-explorer';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const groups = (win: Page): Locator => win.locator('[data-editor-panel-root]');
const EDITOR_TITLE = /^(编辑器|Editor|편집기)( \d+)?$/;
/** 主窗里 dock 标题为「编辑器 N」(n = 1 即「编辑器」)的编辑器组的 dock 组。 */
const dockGroupTitled = (win: Page, n: number): Locator =>
  win.locator('.dv-groupview').filter({
    has: win.locator('.dv-tab').filter({ hasText: n === 1 ? /^(编辑器|Editor|편집기)$/ : new RegExp(` ${n}$`) }),
  });

/** 主窗编辑器组 dock tab 的编号(「编辑器」= 1),按屏幕位置从左到右。 */
const dockNumbersLeftToRight = (win: Page): Promise<number[]> =>
  win.locator('.dv-tab').evaluateAll(
    (els, re) =>
      els
        .map((el) => ({ text: (el.textContent ?? '').trim(), x: el.getBoundingClientRect().x }))
        .filter((t) => new RegExp(re).test(t.text))
        .sort((a, b) => a.x - b.x)
        .map((t) => Number(t.text.match(/ (\d+)$/)?.[1] ?? '1')),
    EDITOR_TITLE.source,
  );

/** 各编辑器组编辑区读屏名称里的组号,按屏幕位置从左到右(不带组号 → 0)。 */
const ariaNumbersLeftToRight = (win: Page): Promise<number[]> =>
  win.locator('[data-editor-panel-root] .cm-content').evaluateAll((els) =>
    els
      .map((el) => ({ label: el.getAttribute('aria-label') ?? '', x: el.getBoundingClientRect().x }))
      .sort((a, b) => a.x - b.x)
      .map((t) => Number(t.label.match(/(?:编辑器组|Editor Group|편집기 그룹) (\d+)$/)?.[1] ?? '0')),
  );

/** 各编辑器组编辑区显示的内容首行,按屏幕位置从左到右。 */
const contentsLeftToRight = (win: Page): Promise<string[]> =>
  win.locator('[data-editor-panel-root] .cm-content').evaluateAll((els) =>
    els
      .map((el) => ({ text: el.querySelector('.cm-line')?.textContent ?? '', x: el.getBoundingClientRect().x }))
      .sort((a, b) => a.x - b.x)
      .map((t) => t.text),
  );

/** 焦点所在编辑器组的屏幕位置序号(从左到右,0 起;不在组里 → -1)。 */
const focusedGroupPosition = (win: Page): Promise<number> =>
  win.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-editor-panel-root]')].sort(
      (a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x,
    );
    const root = document.activeElement?.closest('[data-editor-panel-root]');
    return root ? roots.indexOf(root) : -1;
  });

function workspace(): string {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui71u-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui71u-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(ws, 'b.ts'), 'export const b = 2;\n');
  seedExplorerJson(ud, { root: ws });
  return ud;
}

async function launch(ud: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

/** 打开 a.ts 并 ⌘\ 拆分到 count 个组(左右分栏)。 */
async function splitInto(win: Page, count: number): Promise<void> {
  await openTreeItem(win, /^a\.ts$/);
  const cm = groups(win).first().locator('.cm-content');
  await expect(cm).toContainText('export const a = 1;', { timeout: 10_000 });
  await cm.click();
  for (let n = 2; n <= count; n++) {
    await win.keyboard.press('ControlOrMeta+Backslash');
    await expect(groups(win)).toHaveCount(n, { timeout: 10_000 });
  }
}

interface PersistedLayout {
  readonly grid?: { readonly root?: unknown };
  readonly popoutGroups?: readonly unknown[];
}

/** 等主窗 dock 布局落盘且满足 probe(explorer.json + 旁挂文件合并后:多编辑器组的完整 layout 在旁挂文件里)。 */
async function waitLayoutPersisted(ud: string, probe: (layout: PersistedLayout) => boolean): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          const persisted = readPersistedExplorer(ud) as {
            windows?: Array<{ windowSeq: number; layout?: PersistedLayout }>;
          };
          const layout = persisted.windows?.find((w) => w.windowSeq === 0)?.layout;
          return layout ? probe(layout) : false;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** 网格树最左(深度优先第一个)叶子的第一个面板 id。 */
function firstGridView(node: unknown): string | undefined {
  const n = node as { type?: string; data?: unknown } | undefined;
  if (n?.type === 'leaf') return (n.data as { views?: string[] }).views?.[0];
  if (n?.type === 'branch' && Array.isArray(n.data)) return firstGridView(n.data[0]);
  return undefined;
}

test('dock tab「编辑器 3」拖到最左 → 从左到右仍是「编辑器 | 编辑器 2 | 编辑器 3」,⌘1 聚焦最左组,读屏组号跟位置;重启保留', async () => {
  test.setTimeout(120_000);
  const ud = workspace();
  let { win } = await launch(ud);
  await splitInto(win, 3);
  // 第三组(活动组)改显示 b.ts,便于认出它
  await openTreeItem(win, /^b\.ts$/);
  const A = 'export const a = 1;';
  const B = 'export const b = 2;';
  await expect.poll(() => contentsLeftToRight(win)).toEqual([A, A, B]);
  await expect.poll(() => dockNumbersLeftToRight(win)).toEqual([1, 2, 3]);
  await expect.poll(() => ariaNumbersLeftToRight(win)).toEqual([1, 2, 3]);

  // 拖「编辑器 3」的 dock tab 到最左组内容区的左边缘(dockview 左侧分栏落点)
  const third = win.locator('.dv-tab').filter({ hasText: / 3$/ });
  const leftContent = dockGroupTitled(win, 1).locator('.dv-content-container');
  const box = (await leftContent.boundingBox())!;
  await third.dragTo(leftContent, { targetPosition: { x: 8, y: box.height / 2 } });
  // 换位生效:原第三组(显示 b.ts)现在在最左;编号仍按位置从左到右
  await expect.poll(() => contentsLeftToRight(win)).toEqual([B, A, A]);
  await expect.poll(() => dockNumbersLeftToRight(win)).toEqual([1, 2, 3]);
  await expect.poll(() => ariaNumbersLeftToRight(win)).toEqual([1, 2, 3]);
  await groups(win).first().locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+3');
  await expect.poll(() => focusedGroupPosition(win)).toBe(2);
  await win.keyboard.press('ControlOrMeta+1');
  await expect.poll(() => focusedGroupPosition(win)).toBe(0);
  await expect(win.locator('header').first()).toContainText('b.ts');

  await waitLayoutPersisted(ud, (layout) => firstGridView(layout.grid?.root) === 'editor:3');
  await closeDiscardingUnsaved(apps.pop()!);
  ({ win } = await launch(ud));
  await expect(groups(win)).toHaveCount(3, { timeout: 15_000 });
  await expect.poll(() => contentsLeftToRight(win)).toEqual([B, A, A]);
  await expect.poll(() => dockNumbersLeftToRight(win)).toEqual([1, 2, 3]);
  await groups(win).nth(2).locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+1');
  await expect.poll(() => focusedGroupPosition(win)).toBe(0);
  await win.keyboard.press('ControlOrMeta+2');
  await expect.poll(() => focusedGroupPosition(win)).toBe(1);
});

test('重启恢复的 popout 子窗关掉后:回到主窗的编辑器组重新编号,不与第一组重名', async () => {
  test.setTimeout(120_000);
  const ud = workspace();
  let { app, win } = await launch(ud);
  await splitInto(win, 2);
  // 右组(拆分后获焦、活动)弹到子窗
  await dockGroupTitled(win, 2).getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(2);
  await waitLayoutPersisted(ud, (layout) => (layout.popoutGroups?.length ?? 0) === 1);
  await closeDiscardingUnsaved(apps.pop()!);

  ({ app, win } = await launch(ud));
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(groups(child)).toHaveCount(1, { timeout: 15_000 });
  await expect(groups(win)).toHaveCount(1, { timeout: 15_000 });
  // 用户关掉子窗(窗口关闭按钮 = BrowserWindow.close,子窗收到 beforeunload,dockview 把组收回主窗)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('popout=1'))
      ?.close();
  });
  await expect(groups(win)).toHaveCount(2, { timeout: 15_000 });
  await expect.poll(() => dockNumbersLeftToRight(win)).toEqual([1, 2]);
  await expect.poll(() => ariaNumbersLeftToRight(win)).toEqual([1, 2]);
});

// dockview 移动面板后只激活不移 DOM 焦点:按下 tab 时焦点在 tab 上,tab 随移动被摘下 → 曾落到 body、键入丢失。
// VSCode:拖放编辑器后它成为活动编辑器并获焦。BDD: src/__tests__/focus-after-close/(dock-drop-focus.spec.ts)
for (const where of ['right', 'center'] as const) {
  test(`三组分栏、焦点在组 1,把「编辑器 2」的 dock tab 拖到组 3 ${where === 'right' ? '右缘(分栏)' : '中央(叠放)'} → 被拖的编辑器获焦,可直接键入`, async () => {
    test.setTimeout(90_000);
    const ud = workspace();
    const { win } = await launch(ud);
    await splitInto(win, 3);
    // 组 2 改显示 b.ts,便于认出被拖的编辑器
    await groups(win).nth(1).locator('.cm-content').click();
    await openTreeItem(win, /^b\.ts$/);
    await expect.poll(() => contentsLeftToRight(win)).toEqual(['export const a = 1;', 'export const b = 2;', 'export const a = 1;']);
    await groups(win).first().locator('.cm-content').click();
    await expect.poll(() => focusedGroupPosition(win)).toBe(0);

    const second = win.locator('.dv-tab').filter({ hasText: / 2$/ });
    const target = dockGroupTitled(win, 3).locator('.dv-content-container');
    const box = (await target.boundingBox())!;
    await second.dragTo(target, {
      targetPosition: where === 'right' ? { x: box.width - 8, y: box.height / 2 } : { x: box.width / 2, y: box.height / 2 },
    });
    if (where === 'right') {
      await expect.poll(() => contentsLeftToRight(win)).toEqual(['export const a = 1;', 'export const a = 1;', 'export const b = 2;']);
    } else {
      await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
    }
    const focused = win.locator('[data-editor-panel-root] .cm-content:focus');
    await expect(focused).toHaveCount(1, { timeout: 5_000 });
    await expect(focused).toContainText('export const b = 2;');
    await expect(win.locator('header').first()).toContainText('b.ts');
    await win.keyboard.type('dropped-');
    await expect(focused).toContainText('dropped-');
  });
}
