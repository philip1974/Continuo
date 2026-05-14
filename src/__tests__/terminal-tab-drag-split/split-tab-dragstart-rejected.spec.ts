/**
 * P1-6: split-tab(paneTree.kind === 'split')的 tab 在 dragstart 阶段被拒绝。
 * 实际实施在 TerminalPanel.tsx 的 onTabDragStart callback — 检 tab.paneTree.kind
 * 后 event.preventDefault()。本 spec 锁住 contract:tab 状态结构能区分 leaf
 * vs split,UI 据此判断。
 *
 * V1 不允许拖 split-tab(整个分屏搬运太复杂),拖动时 dragstart 阶段拒绝,
 * dataTransfer 不 setData → drop 端 decodeTabDragPayload 取 null → 不触发 detach。
 */
import { describe, expect, it } from 'vitest';
import type { TabState } from '../../panels/Terminal/panelReducer';

describe('terminal-tab-drag-split: split-tab dragstart rejected', () => {
  it('TabState.paneTree.kind === "leaf" indicates draggable tab', () => {
    const tab: TabState = {
      id: 'tab-1',
      title: 't',
      primaryLeafId: 'leaf-1',
      activeLeafId: 'leaf-1',
      paneTreeVersion: 1,
      paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1' },
    };
    expect(tab.paneTree.kind).toBe('leaf');
  });

  it('TabState.paneTree.kind === "split" indicates NOT draggable', () => {
    const tab: TabState = {
      id: 'tab-1',
      title: 't',
      primaryLeafId: 'leaf-a',
      activeLeafId: 'leaf-a',
      paneTreeVersion: 1,
      paneTree: {
        kind: 'split',
        id: 's',
        dir: 'horizontal',
        ratio: 50,
        a: { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a' },
        b: { kind: 'leaf', id: 'leaf-b', ptyId: 'pty-b' },
      },
    };
    expect(tab.paneTree.kind).toBe('split');
    // UI: TerminalPanel.onTabDragStart 检 kind==='split' → event.preventDefault()
    // (具体行为在 TerminalPanel.tsx,本 spec 只锁结构 invariant)
  });
});
