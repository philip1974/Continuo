// 光标处单词的其它出现处(editor.occurrencesHighlight,默认 singleFile):真实单击词内(无选区)→ 同一个词的每个出现处有高亮底色,
// 大小写不同 / 只是前缀的词不算;设置 off 后不再高亮;大文件开 / 关耗时相近。BDD: src/__tests__/editor-occurrences-highlight/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';
import { compareSettingCost } from './helpers/editor-perf';

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui157-oh-ws-'));
    writeFileSync(path.join(root, 'w.ts'), 'const total = 1;\nconsole.log(total + total);\nconst totals = Total;\n');
    const block = 'function f() {\n    if (total) {\n        return total + 1;\n    }\n';
    writeFileSync(path.join(root, 'big.ts'), block.repeat(25_000));
    writeFileSync(path.join(root, 'min.js'), `var a=${'[total,{"k":"v"},2],'.repeat(100_000)}0;\n`);
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

const marks = (window: Page) =>
  window.locator('.cm-content').first().evaluate((content) =>
    [...content.querySelectorAll('.cm-selectionMatch')].map((el) => ({
      text: el.textContent,
      bg: getComputedStyle(el).backgroundColor,
    })),
  );

test('单击词内 → 该词每个出现处有高亮底色(区分大小写、全词);设置 off → 不再高亮', async ({ window }) => {
  await openWorkspaceFile(window, ['w.ts']);
  await expect(window.locator('.cm-content').first()).toContainText('console.log');
  await window.locator('.cm-line').first().getByText('total').click();
  await expect.poll(async () => (await marks(window)).map((m) => m.text)).toEqual(['total', 'total', 'total']);
  for (const m of await marks(window)) expect(m.bg).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);

  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.occurrencesHighlight', 'off'));
  await window.locator('.cm-line').nth(1).getByText('console').click();
  await window.locator('.cm-line').first().getByText('total').click();
  await window.waitForTimeout(200);
  expect(await marks(window)).toEqual([]);
});

test('改设置即时生效,不必先移光标:off → 已有高亮立即消失;singleFile → 立即出现', async ({ window }) => {
  await openWorkspaceFile(window, ['w.ts']);
  await expect(window.locator('.cm-content').first()).toContainText('console.log');
  await window.locator('.cm-line').first().getByText('total').click();
  await expect.poll(async () => (await marks(window)).length).toBe(3);
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.occurrencesHighlight', 'off'));
  await expect.poll(() => marks(window)).toEqual([]);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.occurrencesHighlight', 'singleFile'));
  await expect.poll(async () => (await marks(window)).length).toBe(3);
});

test('大文件:10 万行与 2 MB 单行 minified,单词高亮开 / 关耗时相近', async ({ window }) => {
  test.setTimeout(180_000);
  await compareSettingCost(window, 'big.ts', false, 'editor.occurrencesHighlight', 'singleFile', 'off');
  await compareSettingCost(window, 'min.js', true, 'editor.occurrencesHighlight', 'singleFile', 'off');
});
