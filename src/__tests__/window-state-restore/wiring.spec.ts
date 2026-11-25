// BDD:接线钉(行为本身由同目录其它 spec 与 e2e window-state-restart 覆盖):DockShell 恢复布局前换算 popout 位置;
// 启动恢复结束后聚焦活动编辑器。见同目录 README 第 2、3 条。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('窗口状态恢复接线', () => {
  it('DockShell:fromJSON 的入参是按主窗原点换算过 popout 位置的布局', () => {
    const src = read('src/shell/dock/DockShell.tsx');
    expect(src).toMatch(
      /\.fromJSON\(\s*popoutPositionsRelativeToWindow\(\s*sanitized,\s*window\.screenX,\s*window\.screenY\s*\)\s*\)/,
    );
  });

  it('main-app:initExplorerPersistence 完成后调用 focusActiveEditorAfterRestore', () => {
    const src = read('src/main-app.ts');
    const call = src.slice(src.indexOf('void initExplorerPersistence('));
    expect(call.slice(0, call.indexOf('renderApp(container)'))).toContain(').then(() => focusActiveEditorAfterRestore());');
  });
});
