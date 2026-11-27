// 编辑器 ⌘S 保存已有文件 = 原地写(同 VSCode):硬链接 / 扩展属性(Finder 标签、user.note)/ 权限位 / 符号链接保存后保持;
// 只读目录(555)里的可写文件可保存;小卷写满时保存失败、原文件完整;APFS 克隆文件(写时复制)磁盘将满时保存失败、原文件逐字节不变。
// BDD: src/__tests__/save-in-place/
import { execFileSync } from 'node:child_process';
import { chmod, link, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';

test.skip(process.platform !== 'darwin', 'xattr / hdiutil 仅 macOS;其它平台由单测覆盖');

async function appendAndSave(window: Page, marker: string): Promise<void> {
  const editor = window.locator('.cm-content').first();
  await editor.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(`\n// ${marker}`);
  await window.keyboard.press('ControlOrMeta+s');
}

test('⌘S 保存后硬链接 / 扩展属性 / 权限位 / inode 保持', async ({ window, workspaceRoot }) => {
  const a = path.join(workspaceRoot, 'src/a.ts');
  const other = path.join(workspaceRoot, 'a-hardlink.ts');
  await link(a, other);
  await chmod(a, 0o755);
  execFileSync('xattr', ['-w', 'user.note', 'keep me', a]);
  execFileSync('xattr', ['-w', 'com.apple.metadata:_kMDItemUserTags', '("Red\n6")', a]);
  const ino = (await stat(a)).ino;

  await openWorkspaceFile(window, ['src', 'a.ts']);
  await appendAndSave(window, 'in-place-1');
  await expect.poll(() => readFile(a, 'utf8'), { timeout: 5_000 }).toContain('in-place-1');

  expect(await readFile(other, 'utf8')).toContain('in-place-1');
  expect((await stat(a)).ino).toBe(ino);
  expect((await stat(a)).nlink).toBe(2);
  expect((await stat(a)).mode & 0o777).toBe(0o755);
  expect(execFileSync('xattr', ['-p', 'user.note', a], { encoding: 'utf-8' }).trim()).toBe('keep me');
  expect(execFileSync('xattr', ['-p', 'com.apple.metadata:_kMDItemUserTags', a], { encoding: 'utf-8' })).toContain('Red');
});

test('符号链接:保存写到目标,链接仍是链接', async ({ window, workspaceRoot }) => {
  const target = path.join(workspaceRoot, 'src/b.ts');
  const linkPath = path.join(workspaceRoot, 'b-link.ts');
  await symlink(target, linkPath);
  const ino = (await stat(target)).ino;

  await openWorkspaceFile(window, ['b-link.ts']);
  await appendAndSave(window, 'via-link');
  await expect.poll(() => readFile(target, 'utf8'), { timeout: 5_000 }).toContain('via-link');
  expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  expect((await stat(target)).ino).toBe(ino);
});

test('只读目录(555)里的可写文件可以保存', async ({ window, workspaceRoot }) => {
  const dir = path.join(workspaceRoot, 'src');
  const a = path.join(dir, 'a.ts');
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await chmod(dir, 0o555);
  try {
    await appendAndSave(window, 'ro-dir');
    await expect.poll(() => readFile(a, 'utf8'), { timeout: 5_000 }).toContain('ro-dir');
  } finally {
    await chmod(dir, 0o755);
  }
});

test.describe('小卷写满', () => {
  // hdiutil create / attach 在负载下要几秒,夹具计入用例超时。
  test.describe.configure({ timeout: 90_000 });
  // 工作区放在 2MB 的 dmg 卷上:见下方 workspaceRoot 覆盖。
  let scratch = '';
  test.use({
    // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
    workspaceRoot: async ({}, use) => {
      scratch = await mkdtemp(path.join(tmpdir(), 'ui121b-vol-'));
      const dmg = path.join(scratch, 'v.dmg');
      const mnt = path.join(scratch, 'mnt');
      execFileSync('hdiutil', ['create', '-size', '2m', '-fs', 'HFS+', '-volname', 'UIFULL', '-layout', 'NONE', dmg], {
        stdio: 'ignore',
      });
      execFileSync('hdiutil', ['attach', dmg, '-mountpoint', mnt, '-nobrowse'], { stdio: 'ignore' });
      try {
        await writeFile(path.join(mnt, 'big.txt'), `# big\n${'x'.repeat(100_000)}\n`);
        await use(mnt);
      } finally {
        try {
          execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });
        } catch {
          /* */
        }
        await rm(scratch, { recursive: true, force: true });
      }
    },
  });

  test('保存超出剩余空间 → 保存失败提示,原文件逐字节不变', async ({ window, workspaceRoot }) => {
    const big = path.join(workspaceRoot, 'big.txt');
    await openWorkspaceFile(window, ['big.txt']);
    // 填满卷:只留约 40KB
    const free = Number(execFileSync('df', ['-k', workspaceRoot], { encoding: 'utf-8' }).trim().split('\n').pop()!.split(/\s+/)[3]);
    await writeFile(path.join(workspaceRoot, 'filler.bin'), Buffer.alloc(Math.max(0, free - 40) * 1024));
    const before = await readFile(big);

    const tabId = await window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());
    await window.evaluate(
      ({ tabId, content }) => globalThis.__continuoTest!.setEditorContent(tabId as string, content),
      { tabId, content: `# big\n${'y'.repeat(1_500_000)}\n` },
    );
    await window.locator('.cm-content').first().click();
    await window.keyboard.press('ControlOrMeta+s');
    await expect(window.getByText(/(磁盘空间不足|Not enough disk space|디스크 공간이 부족)/).first()).toBeVisible({ timeout: 10_000 });
    expect((await readFile(big)).equals(before)).toBe(true);
  });
});

test.describe('APFS 克隆文件(写时复制)磁盘将满', () => {
  test.describe.configure({ timeout: 90_000 });
  // 20 MB APFS dmg:约 2 MB 的源码文件 + `cp -c` 克隆(共享块),卷填到只剩约 1.1 MB。覆盖克隆文件要新空间,
  // 修前删一行保存后原文件末尾变 NUL、变长保存后原文件尾部接上新内容。
  let scratch = '';
  const ORIGINAL = Array.from({ length: 60_000 }, (_, i) => `line ${i} some source code here;\n`).join('');
  test.use({
    // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
    workspaceRoot: async ({}, use) => {
      scratch = await mkdtemp(path.join(tmpdir(), 'ui127a-cow-'));
      const dmg = path.join(scratch, 'v.dmg');
      const mnt = path.join(scratch, 'mnt');
      execFileSync('hdiutil', ['create', '-size', '20m', '-fs', 'APFS', '-volname', 'UICOW', dmg], { stdio: 'ignore' });
      execFileSync('hdiutil', ['attach', dmg, '-mountpoint', mnt, '-nobrowse'], { stdio: 'ignore' });
      try {
        await writeFile(path.join(mnt, 'src.txt'), ORIGINAL);
        execFileSync('cp', ['-c', path.join(mnt, 'src.txt'), path.join(mnt, 'f.txt')]);
        await use(mnt);
      } finally {
        try {
          execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });
        } catch {
          /* */
        }
        await rm(scratch, { recursive: true, force: true });
      }
    },
  });

  async function fillLeavingKb(root: string, leaveKb: number): Promise<void> {
    const free = Number(execFileSync('df', ['-k', root], { encoding: 'utf-8' }).trim().split('\n').pop()!.split(/\s+/)[3]);
    try {
      execFileSync('dd', ['if=/dev/zero', `of=${path.join(root, 'filler.bin')}`, 'bs=1k', `count=${Math.max(0, free - leaveKb)}`], {
        stdio: 'ignore',
      });
    } catch {
      /* 写满即停 */
    }
  }

  for (const [name, next] of [
    ['删掉第 6 行', () => { const l = ORIGINAL.split('\n'); l.splice(5, 1); return l.join('\n'); }],
    ['开头改一字、末尾加 20 KB', () => `X${ORIGINAL.slice(1)}${'c'.repeat(20 * 1024)}`],
  ] as const) {
    test(`${name}后 ⌘S → 提示磁盘空间不足,克隆文件逐字节不变`, async ({ window, workspaceRoot }) => {
      const f = path.join(workspaceRoot, 'f.txt');
      await openWorkspaceFile(window, ['f.txt']);
      await fillLeavingKb(workspaceRoot, 1100);
      const before = await readFile(f);
      expect(before.equals(Buffer.from(ORIGINAL))).toBe(true);

      const tabId = await window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());
      await window.evaluate(
        ({ tabId, content }) => globalThis.__continuoTest!.setEditorContent(tabId as string, content),
        { tabId, content: next() },
      );
      await window.locator('.cm-content').first().click();
      await window.keyboard.press('ControlOrMeta+s');
      await expect(window.getByText(/(磁盘空间不足|Not enough disk space|디스크 공간이 부족)/).first()).toBeVisible({ timeout: 10_000 });
      const after = await readFile(f);
      expect(after.length).toBe(before.length);
      expect(after.includes(0)).toBe(false);
      expect(after.equals(before)).toBe(true);
    });
  }
});
