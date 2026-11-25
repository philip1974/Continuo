// 图片预览与 Markdown 相对路径图片(见 src/__tests__/editor-image-preview/README.md)。
// 回归:打开 .png 弹「文件是二进制或非 UTF-8」;md 里 `![](./q.png)` 请求 out/renderer/q.png 显示破图。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';

/** w×h RGBA PNG:左半不透明蓝、右半全透明(验证棋盘格底)。 */
function makePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 4;
      if (x < w / 2) {
        raw[p] = 40;
        raw[p + 1] = 110;
        raw[p + 2] = 230;
        raw[p + 3] = 255;
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const VIEWER = /^(q\.png，图片预览|q\.png, Image Preview|q\.png, 이미지 미리 보기)$/;
const NOT_UTF8_TOAST = /UTF-8/;

test('打开 png → 只读图片视图(显示图片与尺寸),无 UTF-8 错误;⌘S 不改文件', async ({ window, workspaceRoot }) => {
  mkdirSync(path.join(workspaceRoot, 'img'));
  const png = makePng(64, 48);
  const file = path.join(workspaceRoot, 'img', 'q.png');
  writeFileSync(file, png);
  await openWorkspaceFile(window, ['img', 'q.png']);

  const viewer = window.getByRole('img', { name: VIEWER });
  await expect(viewer).toBeVisible({ timeout: 10_000 });
  const img = viewer.locator('img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);
  await expect(window.getByText(/64x48 · /)).toBeVisible();
  await expect(window.getByText(NOT_UTF8_TOAST)).toHaveCount(0);

  await viewer.focus();
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect(window.getByText(NOT_UTF8_TOAST)).toHaveCount(0);
  expect((await readFile(file)).equals(png)).toBe(true);
});

test('Markdown 相对图片在编辑 / 预览模式加载,工作区外图片不加载(alt 占位),保存后源文本不变', async ({
  window,
  workspaceRoot,
}) => {
  mkdirSync(path.join(workspaceRoot, 'img'));
  writeFileSync(path.join(workspaceRoot, 'img', 'q.png'), makePng(64, 48));
  const outside = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-out-'));
  try {
    const outPng = path.join(outside, 'secret.png');
    writeFileSync(outPng, makePng(8, 8));
    const doc = path.join(workspaceRoot, 'doc.md');
    writeFileSync(doc, `# Images\n\n![logo](./img/q.png)\n\n![out](${outPng})\n`);
    await openWorkspaceFile(window, ['doc.md']);

    for (const mode of [EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW]) {
      await editorModeButton(window, mode).click();
      const pm = window.locator('main .milkdown .ProseMirror');
      const logo = pm.locator('.co-md-image img[alt="logo"]');
      await expect(logo).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: 10_000 });
      await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);
      // 工作区外:不加载,alt 文字占位(不是破图)
      await expect(pm.locator('.co-md-image img[alt="out"]')).toHaveCount(0);
      await expect(pm.locator('.co-md-image [role="img"]', { hasText: 'out' })).toBeVisible();
    }

    await editorModeButton(window, EDITOR_MODE_EDIT).click();
    const pm = window.locator('main .milkdown .ProseMirror');
    await pm.locator('h1').click();
    await window.keyboard.press('End');
    await window.keyboard.type(' edited');
    await window.keyboard.press('ControlOrMeta+KeyS');
    await expect(async () => {
      const content = await readFile(doc, 'utf8');
      expect(content).toContain('# Images edited');
      expect(content).toContain('![logo](./img/q.png)');
      expect(content).toContain(`![out](${outPng})`);
    }).toPass({ timeout: 5_000 });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('编辑模式键入 `![pic](./img/q.png)` → 转成图片并加载;保存后源文本原样(无转义)', async ({ window, workspaceRoot }) => {
  mkdirSync(path.join(workspaceRoot, 'img'));
  writeFileSync(path.join(workspaceRoot, 'img', 'q.png'), makePng(64, 48));
  const doc = path.join(workspaceRoot, 'typed.md');
  writeFileSync(doc, '# Typed\n\nx\n');
  await openWorkspaceFile(window, ['typed.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await pm.locator('p', { hasText: 'x' }).click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('![pic](./img/q.png)');
  const img = pm.locator('.co-md-image img[alt="pic"]');
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: 10_000 });
  await window.screenshot({ path: test.info().outputPath('md-insert-img.png') });
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect(async () => {
    const content = await readFile(doc, 'utf8');
    expect(content).toContain('![pic](./img/q.png)');
    expect(content).not.toContain('\\[');
  }).toPass({ timeout: 5_000 });
});

test('工作区外的 md(经链接打开):同目录图片显示;目录外图片仍不加载', async ({ window, workspaceRoot }) => {
  const outside = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-outdoc-'));
  const other = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-other-'));
  try {
    writeFileSync(path.join(outside, 'o.png'), makePng(32, 24));
    writeFileSync(path.join(other, 'x.png'), makePng(8, 8));
    const outDoc = path.join(outside, 'outside.md');
    writeFileSync(outDoc, `# Outside\n\n![o](./o.png)\n\n![x](${path.join(other, 'x.png')})\n`);
    writeFileSync(path.join(workspaceRoot, 'linkout.md'), `# L\n\n[outside](${outDoc})\n`);
    await openWorkspaceFile(window, ['linkout.md']);
    await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
    await window.locator('main .milkdown .ProseMirror a', { hasText: 'outside' }).click();
    await expect(window.locator('header').first()).toContainText('outside.md', { timeout: 10_000 });
    await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
    const pm = window.locator('main .milkdown .ProseMirror');
    const o = pm.locator('.co-md-image img[alt="o"]');
    await expect(o).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: 10_000 });
    await expect.poll(() => o.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(32);
    await expect(pm.locator('.co-md-image img[alt="x"]')).toHaveCount(0);
    await expect(pm.locator('.co-md-image [role="img"]', { hasText: 'x' })).toBeVisible();
    await window.screenshot({ path: test.info().outputPath('md-outside.png') });
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('图片预览缩放:单击放大(像素化)/ ⌥单击缩小 / ⌘滚轮 / 0 回适应,角落显示比例', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'z.png'), makePng(64, 48));
  await openWorkspaceFile(window, ['z.png']);
  const viewer = window.locator('[data-image-viewer]');
  const img = viewer.locator('img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBe(64);
  const info = window.getByText(/64x48 · /);
  await expect(info).toContainText(/整个图像|Whole Image|전체 이미지/);
  await expect(viewer).toHaveCSS('cursor', 'zoom-in');

  // 焦点不在视图里时首击只激活不缩放(见下一个用例);这里先聚焦视图
  await viewer.focus();
  await img.click(); // 小图适应 = 100% → 下一档 150%
  await expect(info).toContainText('150%');
  await expect(img).toHaveCSS('width', '96px');
  await expect(img).toHaveCSS('image-rendering', 'pixelated');
  await img.click({ modifiers: ['Alt'] });
  await expect(info).toContainText('100%');

  const box = (await viewer.boundingBox())!;
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.keyboard.down('Control');
  await window.mouse.wheel(0, -100);
  await window.keyboard.up('Control');
  await expect(info).toContainText(/10[78]%/);

  for (let i = 0; i < 6; i++) await viewer.press('+'); // 150 200 300 500 700 1000
  await expect(info).toContainText('1000%');
  await window.screenshot({ path: test.info().outputPath('img-zoom.png') });
  await viewer.press('0');
  await expect(info).toContainText(/整个图像|Whole Image|전체 이미지/);
});

test('焦点不在图片视图时,第一下点击只激活(聚焦)不缩放,再点才放大(VSCode imagePreview)', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'z.png'), makePng(64, 48));
  await openWorkspaceFile(window, ['z.png']);
  const viewer = window.locator('[data-image-viewer]');
  const img = viewer.locator('img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBe(64);
  const info = window.getByText(/64x48 · /);
  // 焦点移到资源管理器
  await window.getByRole('treeitem', { name: /z\.png/ }).click();
  await expect(viewer).not.toBeFocused();
  await img.click();
  await expect(viewer).toBeFocused();
  await expect(info).toContainText(/整个图像|Whole Image|전체 이미지/);
  await img.click();
  await expect(info).toContainText('150%');
});
