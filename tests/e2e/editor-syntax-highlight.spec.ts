// 代码编辑器语法高亮:常见语言(language-data 懒加载)有 token 着色;.ts 泛型箭头函数不打断后续高亮。
// BDD: src/__tests__/code-editor-language/
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const FILES: ReadonlyArray<readonly [name: string, content: string, line: number, token: string]> = [
  // [文件, 内容, 断言所在行(0 起), 该行应被着色的 token]
  ['gen.ts', 'const id = <T>(x: T): T => x;\nconst after = "still highlighted";\n', 1, '"still highlighted"'],
  ['main.py', 'import os\n\ndef main():\n    return os.getcwd()\n', 2, 'def'],
  ['ci.yaml', 'name: build\non:\n  push: {}\n', 0, 'name'],
  ['lib.rs', 'pub fn add(a: i32) -> i32 {\n    a + 1\n}\n', 0, 'fn'],
];

test('打开 .ts(泛型箭头函数)/ .py / .yaml / .rs → 代码有 token 高亮 span', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-hl-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-hl-ws-'));
  try {
    for (const [name, content] of FILES) writeFileSync(path.join(ws, name), content);
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      for (const [name, , line, token] of FILES) {
        await win.locator(`text=${name}`).first().click();
        await expect(win.locator('header').first()).toContainText(name, { timeout: 10_000 });
        const lineEl = win.locator('.cm-content .cm-line').nth(line);
        // 着色 token 是 .cm-line 里带 HighlightStyle 类的 span(纯文本时整行只有文本节点)
        await expect(lineEl.locator('span', { hasText: token }).first(), `${name}: ${token}`).toBeVisible({
          timeout: 10_000,
        });
      }
    } finally {
      await closeDiscardingUnsaved(app);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
