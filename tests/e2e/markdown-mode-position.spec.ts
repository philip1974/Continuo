// Markdown 切换 源码 / 编辑 / 预览 时保留阅读位置与光标(VSCode:预览与源码按行同步)。BDD: src/__tests__/markdown-mode-position/
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  EDITOR_MODE_SOURCE,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';

const SECTIONS = 400;
// 每节 4 行:「## Section N」、空行、「Paragraph N body text.」、空行 → 第 N 节标题在第 4N-3 行(约 660 行 ≈ 第 165 节)
const DOC = Array.from({ length: SECTIONS }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} body text.\n`).join('\n');

/** 某滚动容器顶边处可见的第一个元素(按选择器)里的节号。 */
function topSection(window: Page, scroller: string, items: string): Promise<number | null> {
  return window.evaluate(
    ([scrollerSel, itemSel]) => {
      const sc = document.querySelector<HTMLElement>(scrollerSel);
      if (!sc) return null;
      const top = sc.getBoundingClientRect().top;
      for (const el of Array.from(sc.querySelectorAll<HTMLElement>(itemSel))) {
        const r = el.getBoundingClientRect();
        if (r.bottom > top + 1) {
          const m = /(?:Section|Paragraph) (\d+)/.exec(el.textContent ?? '');
          if (m) return Number(m[1]);
        }
      }
      return null;
    },
    [scroller, items] as const,
  );
}

const MILKDOWN_SCROLLER = 'main .h-full.w-full.overflow-auto:has(.ProseMirror)';

test('源码滚到中段切预览 → 预览顶部是同一段;切回源码仍在该段', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'README.md'), DOC);
  await openWorkspaceFile(window, ['README.md']);
  await expect(window.locator('.cm-content')).toContainText('Section 1', { timeout: 10_000 });

  // 源码滚到约 660 行
  await window.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('.cm-scroller')!;
    sc.scrollTop = (sc.scrollHeight * 659) / 1600;
  });
  await expect.poll(() => topSection(window, '.cm-scroller', '.cm-line')).toBeGreaterThan(100);
  const inSource = (await topSection(window, '.cm-scroller', '.cm-line'))!;

  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  await expect(window.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => Math.abs(((await topSection(window, MILKDOWN_SCROLLER, '.ProseMirror > *')) ?? 0) - inSource))
    .toBeLessThanOrEqual(1);

  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  await expect(window.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => Math.abs(((await topSection(window, '.cm-scroller', '.cm-line')) ?? 0) - inSource))
    .toBeLessThanOrEqual(1);
});

test('编辑模式光标所在段落 → 切到源码后光标在该段的行', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'README.md'), DOC);
  await openWorkspaceFile(window, ['README.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const para = window.locator('.ProseMirror p', { hasText: /^Paragraph 37 body text\.$/ });
  await para.scrollIntoViewIfNeeded();
  await para.click();

  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  await expect(window.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  await window.locator('.cm-content').focus();
  await expect(window.locator('.cm-activeLine')).toHaveText('Paragraph 37 body text.');
});
