// 主进程开新窗口入口的接线:依赖整套启动,按仓库惯例做源码钉(runWindowOpen 本身的行为见
// electron/main/__tests__/run-window-open.test.ts)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');

describe('主进程开新窗口入口失败时提示用户', () => {
  it('菜单 / Dock 菜单 / open-file 不再裸 void 调用开窗函数', () => {
    expect(src).not.toMatch(/void openWorkspaceWindow\(/);
    expect(src).not.toMatch(/void openFolderInNewWindow\(/);
    expect(src).not.toMatch(/void openPathInNewWindow\(/);
  });

  it('应用菜单与 Dock 菜单的两个入口都经 runWindowOpen', () => {
    expect(src.match(/runWindowOpen\(\(\) => openWorkspaceWindow\(\)/g) ?? []).toHaveLength(2);
    // 3 处:菜单「在新窗口中打开文件夹…」、Dock 菜单,及菜单「打开文件夹…」无可用主窗时的兜底。
    expect(src.match(/runWindowOpen\(openFolderInNewWindow/g) ?? []).toHaveLength(3);
  });

  it('open-file 经 runWindowOpen', () => {
    const at = src.indexOf("app.on('open-file'");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toMatch(/runWindowOpen\(\(\) => openPathInNewWindow\(filePath\)/);
  });

  it('second-instance 的目录批量打开经 runWindowOpen', () => {
    const at = src.indexOf("app.on('second-instance'");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('\n  });', at));
    expect(body).toMatch(/void runWindowOpen\(async \(\) => \{[\s\S]*openPathInNewWindow\(candidate\)/);
  });

  it('冷启动多目录逐个开窗经 runWindowOpen', () => {
    expect(src).toMatch(
      /void runWindowOpen\(async \(\) => \{\s*for \(let i = 1; i < startup\.dirs\.length[\s\S]{0,120}openWorkspaceWindow\(startup\.dirs\[i\]!\)/,
    );
  });
});
