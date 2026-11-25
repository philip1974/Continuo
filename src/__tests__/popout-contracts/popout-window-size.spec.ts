// BDD:popout 子窗与主窗同一最小尺寸(400×270,同 VSCode 窗口最小尺寸):拖小子窗时 tab 条 / 内容不被压到不可用。
// 子窗由 windowOpenHandler 的 overrideBrowserWindowOptions 建出,按源码钉规则。见同目录 README「子窗口外观」。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('popout 子窗最小尺寸', () => {
  it('windowOpenHandler 放行分支的 overrideBrowserWindowOptions 设 minWidth 400 / minHeight 270(与主窗一致)', () => {
    const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
    const handler = src.slice(src.indexOf('function windowOpenHandler'));
    const opts = handler.slice(handler.indexOf('overrideBrowserWindowOptions'), handler.indexOf('webPreferences'));
    expect(opts).toMatch(/minWidth:\s*400\b/);
    expect(opts).toMatch(/minHeight:\s*270\b/);
    const main = src.slice(src.indexOf('export function createMainWindow'));
    const ctor = main.slice(0, main.indexOf('});'));
    expect(ctor).toMatch(/minWidth:\s*400\b/);
    expect(ctor).toMatch(/minHeight:\s*270\b/);
  });
});
