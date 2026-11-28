// 工作区外的文件 / 没打开文件夹时的文件被外部追加 → 打开它的 tab 自动显示新内容(真实 fs.watch,BDD: src/__tests__/external-sync-outside-workspace/)。
// 修前:只 watch 工作区根,这类文件外部修改后永不重载。文件从 Finder 拖入打开(同 os-file-drop:<input type=file> 取带磁盘路径的 File)。
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test as wsTest, expect } from './fixtures/with-workspace';
import { test as bareTest } from './fixtures/electron-app';
import { EDITOR_TABS, openWorkspaceFile } from './helpers/editor';

/** 模拟从 Finder 把 files(磁盘路径)拖到 target 上放下(同 os-file-drop.spec)。 */
async function finderDrop(window: Page, target: Locator, files: string[]): Promise<void> {
  await window.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'e2e-finder-drop';
    input.style.display = 'none';
    document.body.append(input);
  });
  await window.locator('#e2e-finder-drop').setInputFiles(files);
  const box = (await target.boundingBox())!;
  await target.evaluate(
    (el, at) => {
      const input = document.getElementById('e2e-finder-drop') as HTMLInputElement;
      const dt = new DataTransfer();
      for (const f of Array.from(input.files!)) dt.items.add(f);
      input.remove();
      const init = { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true };
      el.dispatchEvent(new DragEvent('dragover', init));
      el.dispatchEvent(new DragEvent('drop', init));
    },
    { x: box.x + Math.min(40, box.width / 2), y: box.y + Math.min(20, box.height / 2) },
  );
}

const statusBar = (window: Page) => window.locator('footer[data-statusbar]');
const cm = (window: Page) => window.locator('main .cm-content').first();
const tab = (window: Page, name: string) =>
  window.getByRole('tablist', { name: EDITOR_TABS }).first().getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) });

// 钩子在文件级登记,两种 fixture 的用例都执行。
let outside = '';
wsTest.beforeEach(() => {
  outside = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-outlog-'));
  writeFileSync(path.join(outside, 'app.log'), '2026-11-28 10:00:00 INFO first line\n');
  writeFileSync(path.join(outside, 'other.log'), 'OTHER\n');
});
wsTest.afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

wsTest('工作区外日志被外部追加 → 约 1s 内显示;切到别的 tab 期间追加,切回后内容已更新', async ({ window }) => {
  await expect(statusBar(window)).toBeVisible({ timeout: 10_000 });
  await finderDrop(window, statusBar(window), [path.join(outside, 'app.log')]);
  await expect(cm(window)).toContainText('first line', { timeout: 10_000 });
  // .log 按 Log 语言着色(级别关键字是单独的着色片段;纯文本不会切出 span)
  await expect(cm(window).locator('span', { hasText: /^INFO$/ })).toHaveCount(1, { timeout: 10_000 });

  appendFileSync(path.join(outside, 'app.log'), '2026-11-28 10:00:01 WARN second line\n');
  await expect(cm(window)).toContainText('second line', { timeout: 2_000 });

  await finderDrop(window, statusBar(window), [path.join(outside, 'other.log')]);
  await expect(cm(window)).toContainText('OTHER');
  appendFileSync(path.join(outside, 'app.log'), '2026-11-28 10:00:02 ERROR third line\n');
  await window.waitForTimeout(500);

  await tab(window, 'app.log').click();
  await expect(cm(window)).toContainText('third line', { timeout: 2_000 });

  // 第七十轮:ERROR 按日志错误色(--md-syntax-name,暗色下红)+ 粗体着色,不落到通用 invalid 色(暗色下白)。
  const error = cm(window).locator('span', { hasText: /^ERROR$/ }).last();
  await expect(error).toBeVisible();
  const style = await error.evaluate((el) => {
    const probe = (v: string) => {
      const d = document.createElement('span');
      d.style.color = `var(${v})`;
      document.body.append(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    };
    return { color: getComputedStyle(el).color, weight: getComputedStyle(el).fontWeight, name: probe('--md-syntax-name'), invalid: probe('--md-syntax-invalid') };
  });
  expect(style.color).toBe(style.name);
  expect(style.color).not.toBe(style.invalid);
  expect(Number(style.weight)).toBeGreaterThanOrEqual(600);
});

bareTest('没打开文件夹:拖入的日志被外部追加 → 约 1s 内显示', async ({ window }) => {
  await expect(statusBar(window)).toBeVisible({ timeout: 10_000 });
  await finderDrop(window, statusBar(window), [path.join(outside, 'app.log')]);
  await expect(cm(window)).toContainText('first line', { timeout: 10_000 });

  appendFileSync(path.join(outside, 'app.log'), 'appended while no folder is open\n');
  await expect(cm(window)).toContainText('appended while no folder', { timeout: 2_000 });
});

// 第七十轮:另存为到工作区外的新路径(从未经 fs:read-file 读过)→ 外部修改同样自动重载(main 写成功即登记,watch 不再被拒)。
wsTest('另存为到工作区外 → 外部追加约 1s 内显示', async ({ electronApp, window }) => {
  const target = path.join(outside, 'saved.log');
  await electronApp.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, target);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await cm(window).click();
  await window.keyboard.press('ControlOrMeta+Shift+S');
  await expect(tab(window, 'saved.log')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => existsSync(target), { timeout: 10_000 }).toBe(true);
  await window.waitForTimeout(500); // 换路径后的 watch 申请落定

  appendFileSync(target, '\nappended after save as\n');
  await expect(cm(window)).toContainText('appended after save as', { timeout: 2_000 });
});
