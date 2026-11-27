// 查找面板「替换」一次一步、替换结果仍匹配时继续前进、正则空匹配(^)回车逐行、全部替换 ^ 每行一次(对齐 VSCode findModel 的
// replace() 与 _moveToNextMatch 的空匹配处理)。修前:替换后选区停在替换出的文字上(每处按两次),替换结果仍匹配时永远卡住;
// 查 ^ 回车停在 1 / N。
// BDD: src/__tests__/editor-find-widget/
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const MAC = process.platform === 'darwin';
const DOC_START = MAC ? 'Meta+ArrowUp' : 'Control+Home';
const REGEXP_KEY = MAC ? 'Meta+Alt+KeyR' : 'Alt+KeyR';

const lines = (win: Page) => win.locator('.cm-content .cm-line').allTextContents();

/** 打开文件,光标放到文档开头,打开查找面板并输入查找 / 替换词(默认面板在 keyup 时提交查询)。 */
async function openWith(win: Page, file: string, search: string, replace: string, regexp = false): Promise<void> {
  await win.locator(`text=${file}`).first().click();
  await expect(win.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  await win.locator('.cm-content').click();
  await win.keyboard.press(DOC_START);
  await win.keyboard.press('ControlOrMeta+KeyF');
  await expect(win.locator('.cm-search [name="search"]')).toBeFocused();
  if (regexp) await win.keyboard.press(REGEXP_KEY);
  await win.keyboard.type(search);
  await win.locator('.cm-search input[name="replace"]').click();
  await win.keyboard.type(replace);
}

test('替换一次一处并选中下一处;替换结果仍匹配也继续前进;^ 回车逐行、全部替换 ^ 每行一次', async () => {
  test.setTimeout(120_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui123-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui123-ws-'));
  try {
    writeFileSync(path.join(ws, 'food.txt'), 'food a\nfood b\nfood c\n');
    writeFileSync(path.join(ws, 'ids.txt'), 'id=7312\nx id=7312\ny id=7312\n');
    writeFileSync(path.join(ws, 'lines.txt'), 'a\nb\nc\nd');
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      const count = win.locator('.cm-search .cm-search-count');
      const replaceButton = win.locator('.cm-search button[name="replace"]');

      // 替换按钮:第一次只选中第一个匹配,之后每按一次替换一处
      await openWith(win, 'food.txt', 'food', 'MEAL');
      await replaceButton.click();
      expect(await lines(win)).toEqual(['food a', 'food b', 'food c', '']);
      await expect(count).toHaveText('1 / 3');
      await replaceButton.click();
      expect(await lines(win)).toEqual(['MEAL a', 'food b', 'food c', '']);
      await expect(count).toHaveText('1 / 2');
      await replaceButton.click();
      expect(await lines(win)).toEqual(['MEAL a', 'MEAL b', 'food c', '']);
      await replaceButton.click();
      expect(await lines(win)).toEqual(['MEAL a', 'MEAL b', 'MEAL c', '']);

      // 替换框回车:不区分大小写 id=7312 → ID=7312(结果仍匹配)逐处前进,不卡在同一处
      await openWith(win, 'ids.txt', 'id=7312', 'ID=7312');
      for (let i = 0; i < 4; i++) await win.keyboard.press('Enter');
      expect(await lines(win)).toEqual(['ID=7312', 'x ID=7312', 'y ID=7312', '']);

      // 正则 ^:查找框回车逐行前进(修前停在 1 / 4),到尾绕回
      await openWith(win, 'lines.txt', '^', '> ', true);
      await win.locator('.cm-search [name="search"]').click();
      await expect(count).toHaveText('1 / 4');
      const seen: string[] = [];
      for (let i = 0; i < 4; i++) {
        await win.keyboard.press('Enter');
        seen.push((await count.textContent()) ?? '');
      }
      expect(seen).toEqual(['2 / 4', '3 / 4', '4 / 4', '1 / 4']);
      await win.keyboard.press('Shift+Enter');
      await expect(count).toHaveText('4 / 4');

      // 替换 ^ 一次一行(选区正是第 4 行行首的空匹配:替换它,绕回选中第 1 行);全部替换每行一次
      await replaceButton.click();
      expect(await lines(win)).toEqual(['a', 'b', 'c', '> d']);
      await replaceButton.click();
      expect(await lines(win)).toEqual(['> a', 'b', 'c', '> d']);
      await win.locator('.cm-search button[name="replaceAll"]').click();
      expect(await lines(win)).toEqual(['> > a', '> b', '> c', '> > d']);
    } finally {
      await closeDiscardingUnsaved(app);
    }
  } finally {
    rmSync(ud, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
