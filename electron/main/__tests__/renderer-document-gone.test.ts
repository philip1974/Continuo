import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { onRendererDocumentGone } from '../lib/renderer-document-gone';

type Wc = Parameters<typeof onRendererDocumentGone>[0];

function setup() {
  const wc = new EventEmitter();
  const gone = vi.fn();
  onRendererDocumentGone(wc as unknown as Wc, gone);
  return { wc, gone };
}

describe('onRendererDocumentGone', () => {
  it('主框架提交导航(did-navigate)/ 渲染进程崩溃 → 回调', () => {
    const { wc, gone } = setup();
    wc.emit('did-navigate', {}, 'file:///x', 200, 'OK');
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(gone).toHaveBeenCalledTimes(2);
  });

  it('主框架加载失败 → 回调;ERR_ABORTED(-3)与子框架失败不算', () => {
    const { wc, gone } = setup();
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///x', true);
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x', false);
    expect(gone).not.toHaveBeenCalled();
    wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('did-start-navigation 不算(未提交的导航文档原样留着)', () => {
    const { wc, gone } = setup();
    wc.emit('did-start-navigation', {});
    expect(gone).not.toHaveBeenCalled();
  });
});

describe('接线:三套 renderer 就绪握手都按同一判定作废', () => {
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, '..', rel), 'utf-8').replace(/\s+/g, ' ');

  it('agent 授权、co:// 深链、关窗 flush / 脏态都调用 onRendererDocumentGone', () => {
    expect(read('services/agent-auth.service.ts')).toContain('onRendererDocumentGone(wc, onGone)');
    const index = read('index.ts');
    expect(index).toMatch(/onRendererDocumentGone\(win\.webContents, \(\) => protocolReadyContents\.delete/);
    // 关窗 flush:文档换掉时清就绪与脏态(否则崩溃后关窗空等超时、reload 后弹幽灵脏文件确认框)。
    expect(index).toMatch(
      /onRendererDocumentGone\(win\.webContents, \(\) => \{ flushReadyWindowIds\.delete\(windowId\); if \(dirtyStates\.delete\(windowId\)/,
    );
  });
});
