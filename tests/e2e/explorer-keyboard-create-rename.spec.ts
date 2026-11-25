// Explorer 交互对齐 VSCode 的真机路径:键盘 Enter 打开、新建文件后自动打开并选中、重命名失焦提交 + F2 预选主名。
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_NEW_FILE, EXPLORER_NEW_FILE_PLACEHOLDER } from './helpers/explorer';

const rowOf = (window: import('@playwright/test').Page, p: string) =>
  window.locator(`[role=treeitem][title="${p}"]`);

test('方向键移到文件(选中跟随)+ Enter → 在编辑器打开', async ({ window, workspaceRoot }) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click(); // 展开 src + 焦点
  const a = rowOf(window, path.join(workspaceRoot, 'src/a.ts'));
  await expect(a).toBeVisible();
  await src.press('ArrowDown');
  await expect(a).toBeFocused();
  await expect(a).toHaveAttribute('aria-selected', 'true');
  await expect(src).toHaveAttribute('aria-selected', 'false');
  await a.press('Enter');
  await expect(window.locator('header').first()).toContainText('a.ts', { timeout: 10_000 });
});

test('右键 src → 新建文件 → 落盘后在编辑器打开,树里新文件被选中', async ({
  window,
  workspaceRoot,
}) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  // src 折叠状态下新建:成功后应自动展开
  await src.click({ button: 'right' });
  const newFile = window.getByRole('menuitem', { name: EXPLORER_NEW_FILE });
  await expect(newFile).toBeVisible({ timeout: 5_000 });
  await newFile.click();
  const input = window.getByRole('textbox', { name: EXPLORER_NEW_FILE_PLACEHOLDER });
  await expect(input).toBeVisible();
  await input.fill('hello.ts');
  await input.press('Enter');

  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/hello.ts'));
  }).toPass({ timeout: 5_000 });
  await expect(window.locator('header').first()).toContainText('hello.ts', { timeout: 10_000 });
  const hello = rowOf(window, path.join(workspaceRoot, 'src/hello.ts'));
  await expect(hello).toBeVisible();
  await expect(hello).toHaveAttribute('aria-selected', 'true');
  await expect(input).toBeHidden();
});

test('F2 预选主名,键入替换主名后点别处(失焦)→ 提交重命名', async ({ window, workspaceRoot }) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click();
  await src.press('ArrowDown'); // 焦点 + 选中移到 a.ts(不经单击,不打开编辑器)
  const a = rowOf(window, path.join(workspaceRoot, 'src/a.ts'));
  await expect(a).toBeFocused();
  await a.press('F2');
  const input = window.locator('[role=treeitem] input');
  await expect(input).toBeFocused({ timeout: 5_000 });
  // 预选 "a"(不含 .ts):直接键入即替换主名
  await window.keyboard.type('renamed');
  await expect(input).toHaveValue('renamed.ts');
  // 点到树外(状态栏)→ 失焦提交
  await window.locator('footer').first().click();
  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/renamed.ts'));
  }).toPass({ timeout: 5_000 });
  await expect(input).toBeHidden();
});

// 焦点去向(VSCode):Enter 打开 = explorer.openAndPassFocus;重命名 Enter 后焦点留在新项;放弃新建后焦点回树。
// BDD: src/__tests__/explorer-tree/、src/__tests__/editor-focus-on-open/
test('键盘 Enter 打开文件 → 焦点进编辑器,可直接键入', async ({ window, workspaceRoot }) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click();
  const a = rowOf(window, path.join(workspaceRoot, 'src/a.ts'));
  // 点击展开是异步列目录:子项出现前按 ↓ 会落到下一个兄弟行(高负载下偶发),先等子项渲染
  await expect(a).toBeVisible();
  await src.press('ArrowDown');
  await expect(a).toBeFocused();
  await a.press('Enter');
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('enter-open');
  await expect(cm).toContainText('enter-open');
});

test('F2 改名后按 Enter → 焦点与选中留在改名后的项', async ({ window, workspaceRoot }) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click();
  const a = rowOf(window, path.join(workspaceRoot, 'src/a.ts'));
  const b = rowOf(window, path.join(workspaceRoot, 'src/b.ts'));
  await expect(a).toBeVisible();
  await window.keyboard.press('ArrowDown');
  await expect(a).toBeFocused();
  await window.keyboard.press('ArrowDown');
  await expect(b).toBeFocused();
  await b.press('F2');
  const input = window.locator('[role=treeitem] input');
  await expect(input).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('b2');
  await expect(input).toHaveValue('b2.ts');
  await input.press('Enter');
  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/b2.ts'));
  }).toPass({ timeout: 5_000 });
  const b2 = rowOf(window, path.join(workspaceRoot, 'src/b2.ts'));
  await expect(b2).toBeFocused({ timeout: 5_000 });
  await expect(b2).toHaveAttribute('aria-selected', 'true');
  // 库的焦点轮询(500ms)过后也不被打回首项
  await window.waitForTimeout(800);
  await expect(b2).toBeFocused();
});

test('右键新建文件 → Esc 放弃 → 焦点回到树的焦点行', async ({ window, workspaceRoot }) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click({ button: 'right' });
  const newFile = window.getByRole('menuitem', { name: EXPLORER_NEW_FILE });
  await expect(newFile).toBeVisible({ timeout: 5_000 });
  await newFile.click();
  const input = window.getByRole('textbox', { name: EXPLORER_NEW_FILE_PLACEHOLDER });
  await expect(input).toBeFocused({ timeout: 5_000 });
  await input.press('Escape');
  await expect(input).toBeHidden();
  await expect(src).toBeFocused({ timeout: 5_000 });
});
