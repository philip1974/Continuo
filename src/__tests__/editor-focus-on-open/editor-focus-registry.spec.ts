// @vitest-environment jsdom
// 「打开后把焦点交给编辑器」请求的兑现时机(见同目录 README.md)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerEditorFocus,
  requestEditorFocus,
} from '../../panels/Editor/editor-focus-registry';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('编辑器焦点请求', () => {
  it('视图已就绪 → 下一帧聚焦(晚于 Modal 关闭还焦点 / 旧编辑器卸载)', async () => {
    const focus = vi.fn();
    cleanups.push(registerEditorFocus('/a.ts', focus));
    requestEditorFocus('/a.ts');
    expect(focus).not.toHaveBeenCalled();
    await nextFrame();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('视图尚未挂载(读盘 / 引擎 chunk 加载中)→ 挂载后聚焦一次', async () => {
    requestEditorFocus('/b.ts');
    await nextFrame();
    const focus = vi.fn();
    cleanups.push(registerEditorFocus('/b.ts', focus));
    await nextFrame();
    expect(focus).toHaveBeenCalledTimes(1);
    // 请求已兑现:之后的重挂载不再抢焦点
    const again = vi.fn();
    cleanups.push(registerEditorFocus('/b.ts', again));
    await nextFrame();
    expect(again).not.toHaveBeenCalled();
  });

  it('只兑现给被请求的 tab;更新的请求取代旧请求', async () => {
    requestEditorFocus('/c.ts');
    requestEditorFocus('/d.ts');
    const c = vi.fn();
    const d = vi.fn();
    cleanups.push(registerEditorFocus('/c.ts', c));
    cleanups.push(registerEditorFocus('/d.ts', d));
    await nextFrame();
    expect(c).not.toHaveBeenCalled();
    expect(d).toHaveBeenCalledTimes(1);
  });

  it('注销后的视图不再被聚焦', async () => {
    const focus = vi.fn();
    const unregister = registerEditorFocus('/e.ts', focus);
    requestEditorFocus('/e.ts');
    unregister();
    await nextFrame();
    expect(focus).not.toHaveBeenCalled();
  });
});
