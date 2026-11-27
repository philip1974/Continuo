// 状态栏字数:CJK 表意字 / 假名每字计 1 词,全角标点不计,英文仍按整词。BDD: src/__tests__/text-stats/
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';

const WORDS = /(词|words?|단어)/;

test('中文 / 中英混排 / 扩展区汉字的字数', async ({ window, workspaceRoot }) => {
  // 今天天气很好(6)+ 用 / React / 写(3)+ 𠀀(扩展 B,1)+ ひらがな(4)= 14;，。！不计
  writeFileSync(path.join(workspaceRoot, 'cjk.txt'), '今天天气很好，用React写。𠀀！ひらがな');
  await openWorkspaceFile(window, ['cjk.txt']);
  await expect(window.locator('footer')).toContainText(new RegExp(`14\\s*${WORDS.source}`), { timeout: 10_000 });
});
