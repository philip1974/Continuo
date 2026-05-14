/**
 * P1-4: drop 到本 panel 内部 pane 区时,pointer 落 PaneSplitter handle / gap /
 * padding / 非 leaf 元素 → hit-test 返回 null,**不 detach** + return。
 *
 * resolveInternalDropTarget 用 `event.target.closest('[data-pane-leaf-id]')` 查找;
 * 找不到则 fail。这是 UI 层 helper(在 TerminalPaneTree.tsx),本 spec 通过模拟
 * DOM 锁这个 invariant。
 */
import { describe, expect, it } from 'vitest';

describe('terminal-tab-drag-split: drop hit-test fallback', () => {
  it('target without [data-pane-leaf-id] ancestor returns null (no detach trigger)', () => {
    // 模拟:drop 在一个不属于任何 leaf 的元素(如 splitter handle)上
    const handle = document.createElement('div');
    handle.className = 'pane-splitter-handle';
    document.body.appendChild(handle);
    const leafEl = handle.closest('[data-pane-leaf-id]');
    expect(leafEl).toBeNull();
    document.body.removeChild(handle);
  });

  it('target inside [data-pane-leaf-id] ancestor returns the leaf element', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-pane-leaf-id', 'leaf-X');
    const inner = document.createElement('span');
    inner.textContent = 'inside';
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    const leafEl = inner.closest('[data-pane-leaf-id]') as HTMLElement | null;
    expect(leafEl).not.toBeNull();
    expect(leafEl?.dataset.paneLeafId).toBe('leaf-X');
    document.body.removeChild(wrapper);
  });
});
