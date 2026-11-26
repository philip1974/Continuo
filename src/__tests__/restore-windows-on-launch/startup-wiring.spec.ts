// 主进程启动 / 退出接线依赖整套启动,按仓库惯例做源码钉(行为由 restore-windows.spec 的纯函数、close-flush.spec 的
// 关窗 / 退出用例与 e2e restore-windows-on-launch.spec 覆盖)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');

function beforeQuitBody(): string {
  const at = src.indexOf("app.on('before-quit'");
  expect(at).toBeGreaterThan(0);
  return src.slice(at);
}

describe('启动:首窗 + 恢复其余 + 焦点给最后活动的窗口', () => {
  it('首窗 seq 由 pickPrimaryWindowSeq 决定(不再固定 0)', () => {
    expect(src).toContain('createMainWindow({ windowSeq: startupData ? pickPrimaryWindowSeq(startupData) : 0 })');
    expect(src).not.toMatch(/\/\/ 正常启动[^\n]*\n\s*createMainWindow\(\{ windowSeq: 0 \}\);/);
  });

  it('恢复完成后(确实恢复了别的窗口、未取消)聚焦最后活动的窗口', () => {
    expect(src).toMatch(
      /restoreStartupWindows\([\s\S]{0,400}restoredCount \+= 1;[\s\S]{0,400}\.then\(\(\) => \{[\s\S]{0,200}lastActiveWindowSeq\(startupData\)[\s\S]{0,40}if \(restoredCount > 0 && lastActive !== null && !startupRestoreCancelled\) focusMainWindowBySeq\(lastActive\)/,
    );
  });
});

describe('退出:记录退出时开着的主窗口(按最近活动排序)', () => {
  it('退出确定(flushedOnQuit 登记之后)才置 quitCommitted', () => {
    const body = beforeQuitBody();
    const flushed = body.indexOf('for (const w of targets) flushedOnQuit.add(w.id);');
    const committed = body.indexOf('quitCommitted = true;');
    expect(flushed).toBeGreaterThan(0);
    expect(committed).toBeGreaterThan(flushed);
  });

  it('persistWindowStates 带上按最近活动排序的开着的窗口', () => {
    expect(beforeQuitBody()).toContain('persistWindowStates(targetSeqs, orderByRecentFocus(targetSeqs, mainWindowFocusOrder))');
  });

  it('退出关窗(quitCommitted)不把窗口移出 openWindowSeqs;关窗当刻同步取状态', () => {
    expect(src).toContain('const userClosedDuringQuit = quitCommitted;');
    expect(src).toContain('if (!userClosedDuringQuit) updateOpenWindowSeqsOnUserClose(payload, seq, remainingSeqs);');
  });

  it('主窗聚焦与其 popout 子窗聚焦都记为该主窗活动', () => {
    expect(src).toContain("win.on('focus', () => touchMainWindowFocus(seq));");
    expect(src).toMatch(/child\.on\('focus', \(\) => \{[\s\S]{0,250}touchMainWindowFocus\(seq\)/);
  });
});
