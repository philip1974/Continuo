// 非 UTF-8 编码:UTF-16 LE / BE 带 BOM 打开编辑保存字节级正确;GBK 文件打开时选编码、保存字节正确;表示不了的字符提示且文件
// 不变;状态栏显示编码 / 行尾,切换行尾、通过编码保存写回正确字节。BDD: src/__tests__/editor-text-encoding/
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';
import { openWorkspaceFile } from './helpers/editor';

const utf16le = (s: string) => Buffer.from(s, 'utf16le');
const utf16be = (s: string) => {
  const b = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1]!, b[i]!];
  return b;
};
const LE_BOM = Buffer.from([0xff, 0xfe]);
const BE_BOM = Buffer.from([0xfe, 0xff]);

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui124b-enc-ws-'));
    writeFileSync(path.join(root, 'le.txt'), Buffer.concat([LE_BOM, utf16le('hello\r\nworld\r\n')]));
    writeFileSync(path.join(root, 'be.txt'), Buffer.concat([BE_BOM, utf16be('hello\nworld\n')]));
    writeFileSync(path.join(root, 'gbk.txt'), iconv.encode('中文内容\n', 'gbk'));
    writeFileSync(path.join(root, 'lf.txt'), 'one\ntwo\n');
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

const footer = (window: Page) => window.locator('footer');
const encodingItem = (window: Page) => footer(window).locator('[data-statusbar-encoding]');
const eolItem = (window: Page) => footer(window).locator('[data-statusbar-eol]');
const pick = (window: Page, id: string) => window.locator(`.wm-modal-content [data-encoding-pick="${id}"]`);
const bytesOf = (file: string) => [...readFileSync(file)];

async function appendAndSave(window: Page, text: string): Promise<void> {
  const editor = window.locator('.cm-content').first();
  await editor.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.insertText(text);
  await window.keyboard.press('ControlOrMeta+s');
}

test('UTF-16 LE / BE 带 BOM:状态栏显示编码与行尾,编辑保存字节级正确', async ({ window, workspaceRoot }) => {
  await openWorkspaceFile(window, ['le.txt']);
  await expect(window.locator('.cm-content').first()).toContainText('world');
  await expect(encodingItem(window)).toHaveText('UTF-16 LE');
  await expect(eolItem(window)).toHaveText('CRLF');
  await appendAndSave(window, 'X');
  const le = path.join(workspaceRoot, 'le.txt');
  await expect.poll(() => bytesOf(le), { timeout: 5_000 }).toEqual([...LE_BOM, ...utf16le('hello\r\nworld\r\nX')]);

  await openWorkspaceFile(window, ['be.txt']);
  await expect(encodingItem(window)).toHaveText('UTF-16 BE');
  await expect(eolItem(window)).toHaveText('LF');
  await appendAndSave(window, '中');
  const be = path.join(workspaceRoot, 'be.txt');
  await expect.poll(() => bytesOf(be), { timeout: 5_000 }).toEqual([...BE_BOM, ...utf16be('hello\nworld\n中')]);
});

test('GBK:打开时弹编码选择器,选 GBK 后打开;保存字节正确;emoji 保存被拒并提示,文件不变', async ({
  window,
  workspaceRoot,
}) => {
  const gbk = path.join(workspaceRoot, 'gbk.txt');
  await explorerTreeItem(window, /^gbk\.txt$/).click();
  await expect(pick(window, 'gbk')).toBeVisible({ timeout: 10_000 });
  await expect(pick(window, 'utf8bom')).toHaveCount(0); // 打开 / 重新打开不列 UTF-8 with BOM
  await pick(window, 'gbk').click();
  await expect(window.locator('.cm-content').first()).toContainText('中文内容');
  await expect(encodingItem(window)).toHaveText('GBK');

  await appendAndSave(window, '测试');
  await expect.poll(() => bytesOf(gbk), { timeout: 5_000 }).toEqual([...iconv.encode('中文内容\n测试', 'gbk')]);

  const before = bytesOf(gbk);
  await appendAndSave(window, '😀');
  await expect(window.getByText(/cannot represent|无法表示|표현할 수 없는/).first()).toBeVisible({ timeout: 5_000 });
  expect(bytesOf(gbk)).toEqual(before);
});

test('切换行尾 LF → CRLF 写回;通过编码保存为 UTF-16 LE 写回 BOM', async ({ window, workspaceRoot }) => {
  const lf = path.join(workspaceRoot, 'lf.txt');
  await openWorkspaceFile(window, ['lf.txt']);
  await expect(encodingItem(window)).toHaveText('UTF-8');
  await expect(eolItem(window)).toHaveText('LF');
  await eolItem(window).click();
  await pick(window, 'CRLF').click();
  await expect(eolItem(window)).toHaveText('CRLF');
  await window.locator('.cm-content').first().click();
  await window.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFileSync(lf, 'utf8'), { timeout: 5_000 }).toBe('one\r\ntwo\r\n');

  await encodingItem(window).click();
  await pick(window, 'save').click();
  await pick(window, 'utf16le').click();
  await expect(encodingItem(window)).toHaveText('UTF-16 LE');
  await expect.poll(() => bytesOf(lf), { timeout: 5_000 }).toEqual([...LE_BOM, ...utf16le('one\r\ntwo\r\n')]);
});
