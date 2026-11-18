// r5 审计 #1(P1):启动恢复目录判定改 async 后,慢 stat 期间用户关掉最后一个窗口 / 触发退出,
// 恢复完成后仍 createMainWindow(macOS 窗口「复活」;退出时新窗落在 before-quit 已取快照之外,
// 绕过 flush / 清理)。restoreStartupWindows 的取消语义由 window-restore.spec 行为测试覆盖;
// 主进程事件接线依赖整套启动,按仓库惯例做源码钉。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');

function handlerBody(event: string): string {
  const at = src.indexOf(`app.on('${event}'`);
  expect(at).toBeGreaterThan(0);
  // 截到下一个 app.on 为止,避免相邻处理器的置位让本处理器假通过
  const next = src.indexOf('\napp.on(', at + 1);
  return src.slice(at, next > at ? next : at + 400);
}

describe('启动窗口恢复在退出 / 全部关窗时取消', () => {
  it('启动恢复经 restoreStartupWindows 编排,并传入取消判定', () => {
    expect(src).toMatch(/restoreStartupWindows\([\s\S]{0,300}\(\) => startupRestoreCancelled/);
    expect(src).not.toMatch(/await pickWindowsToRestore\(/);
  });

  it.each(['before-quit', 'will-quit', 'window-all-closed'])(
    '%s 处理器一开始(任何 await 之前)置位取消标志',
    (event) => {
      const body = handlerBody(event);
      const setAt = body.indexOf('startupRestoreCancelled = true');
      expect(setAt).toBeGreaterThan(0);
      const awaitAt = body.indexOf('await ');
      if (awaitAt >= 0) expect(setAt).toBeLessThan(awaitAt);
    },
  );
});
