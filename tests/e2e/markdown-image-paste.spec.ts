// Markdown 粘贴 / 拖入图片(见 src/__tests__/markdown-image-paste/README.md)。
// 回归:编辑视图粘贴截图写进 `![](blob:file:///…)`、图片没保存;源码视图粘贴图片什么都不发生。
// 粘贴用合成的 ClipboardEvent(带真实 File,不动系统剪贴板);Finder 拖入用 <input type=file> 取得带磁盘路径的 File。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, EDITOR_MODE_SOURCE, editorModeButton, openWorkspaceFile } from './helpers/editor';

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
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4), 200);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 4)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 在 target 上派发合成粘贴:剪贴板里只有一张 png(同截图;文件名为 Chromium 给的 image.png)。 */
async function pastePng(target: Locator, png: Buffer): Promise<void> {
  await target.evaluate((el, bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [...png]);
}

/** 模拟从 Finder 拖入磁盘文件 file 到 target(File 经 <input type=file> 取得,带真实路径)。 */
async function dropDiskFile(window: Page, target: Locator, file: string): Promise<void> {
  await window.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'e2e-drop-file';
    input.style.display = 'none';
    document.body.append(input);
  });
  await window.locator('#e2e-drop-file').setInputFiles(file);
  const box = (await target.boundingBox())!;
  await target.evaluate(
    (el, at) => {
      const input = document.getElementById('e2e-drop-file') as HTMLInputElement;
      const dt = new DataTransfer();
      dt.items.add(input.files![0]!);
      input.remove();
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    },
    { x: box.x + 10, y: box.y + box.height - 5 },
  );
}

let app: ElectronApplication | undefined;
let ud = '';
let ws = '';

test.beforeEach(() => {
  ud = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-ud-'));
  ws = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-ws-'));
  mkdirSync(path.join(ws, 'docs'));
  writeFileSync(path.join(ws, 'docs', 'note.md'), '# Note\n\nfirst\n');
  seedExplorerJson(ud, { root: ws });
});
test.afterEach(async () => {
  if (app) await closeDiscardingUnsaved(app);
  app = undefined;
  rmSync(ud, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  app = await launchContinuo(ud);
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return window;
}

const doc = () => path.join(ws, 'docs', 'note.md');
const pmOf = (window: Page) => window.locator('main .milkdown .ProseMirror');

test('编辑 / 源码视图粘贴 png → 图片落在文档旁、md 里是相对路径(无 blob:);重启后图片照常显示', async () => {
  test.setTimeout(90_000);
  const png = makePng(40, 30);
  let window = await launch();
  await openWorkspaceFile(window, ['docs', 'note.md']);

  // 编辑视图
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = pmOf(window);
  await pm.locator('p', { hasText: 'first' }).click();
  await window.keyboard.press('End');
  await pastePng(pm, png);
  await expect(pm.locator('.co-md-image img')).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: 10_000 });
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect.poll(() => readFileSync(doc(), 'utf8'), { timeout: 10_000 }).toContain('![](image.png)');
  expect(readFileSync(doc(), 'utf8')).not.toMatch(/blob:|data:/);
  expect(readFileSync(path.join(ws, 'docs', 'image.png')).equals(png)).toBe(true);

  // 源码视图:同名已存在 → image-1.png,插入 `![alt text](image-1.png)` 并选中 alt 占位
  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  const cm = window.locator('main .cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.press('Enter');
  await pastePng(cm, png);
  await expect(cm).toContainText('![alt text](image-1.png)', { timeout: 10_000 });
  await window.keyboard.type('shot');
  await expect(cm).toContainText('![shot](image-1.png)');
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect.poll(() => readFileSync(doc(), 'utf8'), { timeout: 10_000 }).toContain('![shot](image-1.png)');
  expect(readdirSync(path.join(ws, 'docs')).sort()).toEqual(['image-1.png', 'image.png', 'note.md']);

  // 重启:两张图都显示
  await closeDiscardingUnsaved(app!);
  app = undefined;
  window = await launch();
  await openWorkspaceFile(window, ['docs', 'note.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  const imgs = pmOf(window).locator('.co-md-image img');
  await expect(imgs).toHaveCount(2, { timeout: 10_000 });
  for (const i of [0, 1]) {
    await expect.poll(() => imgs.nth(i).evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBe(40);
  }
});

test('Finder 拖入图片:工作区内的直接引用相对路径(不复制);工作区外的复制到文档旁', async () => {
  test.setTimeout(60_000);
  mkdirSync(path.join(ws, 'assets'));
  writeFileSync(path.join(ws, 'assets', 'logo.png'), makePng(8, 8));
  const outside = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-out-'));
  try {
    writeFileSync(path.join(outside, 'my photo.png'), makePng(12, 12));
    const window = await launch();
    await openWorkspaceFile(window, ['docs', 'note.md']);
    await editorModeButton(window, EDITOR_MODE_EDIT).click();
    const pm = pmOf(window);
    await expect(pm).toBeVisible({ timeout: 10_000 });

    await dropDiskFile(window, pm, path.join(ws, 'assets', 'logo.png'));
    await expect(pm.locator('.co-md-image img')).toHaveCount(1, { timeout: 10_000 });
    await dropDiskFile(window, pm, path.join(outside, 'my photo.png'));
    await expect(pm.locator('.co-md-image img')).toHaveCount(2, { timeout: 10_000 });
    await window.keyboard.press('ControlOrMeta+KeyS');
    await expect
      .poll(() => readFileSync(doc(), 'utf8'), { timeout: 10_000 })
      .toMatch(/!\[\]\(\.\.\/assets\/logo\.png\)[\s\S]*!\[\]\(<my photo\.png>\)|!\[\]\(<my photo\.png>\)[\s\S]*!\[\]\(\.\.\/assets\/logo\.png\)/);
    expect(readdirSync(path.join(ws, 'docs')).sort()).toEqual(['my photo.png', 'note.md']);
    expect(readdirSync(path.join(ws, 'assets'))).toEqual(['logo.png']);
    expect(readdirSync(outside)).toEqual(['my photo.png']);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
