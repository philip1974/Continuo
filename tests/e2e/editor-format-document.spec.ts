// 格式化文档(⇧⌥F / Shift+Alt+F,BDD: src/__tests__/editor-language-commands/):jsonc / tsconfig.json 有尾逗号 → 照常格式化,
// 尾逗号原样保留(VSCode JSON 格式化用 jsonc-parser format,只按 token 排版,不因尾逗号拒绝,第五十轮审计 A3)。
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';

const editorText = (window: Page): Promise<string> =>
  window.evaluate(() =>
    Array.from(document.querySelectorAll('main .cm-content .cm-line'))
      .map((l) => l.textContent)
      .join('\n'),
  );

for (const name of ['tsconfig.json', 'settings.jsonc']) {
  test(`${name} 有尾逗号:格式化文档照常排版、尾逗号保留,保存后写盘`, async ({ window, workspaceRoot }) => {
    const file = path.join(workspaceRoot, name);
    writeFileSync(file, '{"compilerOptions":{"strict":true,"lib":["dom","es2022",],},// tail\n}\n');
    await openWorkspaceFile(window, [name]);
    const cm = window.locator('main .cm-content').first();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await cm.click();
    await window.keyboard.press('Shift+Alt+KeyF');
    // 原文没有缩进 → 缩进单位取编辑器默认(4 空格)
    const expected = [
      '{',
      '    "compilerOptions": {',
      '        "strict": true,',
      '        "lib": [',
      '            "dom",',
      '            "es2022",',
      '        ],',
      '    }, // tail',
      '}',
      '',
    ].join('\n');
    await expect.poll(() => editorText(window), { timeout: 5_000 }).toBe(expected);
    await window.keyboard.press('ControlOrMeta+KeyS');
    await expect.poll(() => readFile(file, 'utf8'), { timeout: 5_000 }).toBe(expected);
  });
}
