// @vitest-environment jsdom
// perf E3:EditorHeader memo 化 —— EditorPanel 每按键(active tab 正文变)都重渲,EditorHeader 的
// 唯一 prop onCloseRequest 是稳定 useCallback,store 依赖全走自身窄订阅(chromeVersion/activeTabId/
// mode/locale)。父级重渲且 props 不变 → EditorHeader 不重渲(不再重建全部 TabNavItem);
// 自身订阅的 chrome 变化 → 照常更新。
// 渲染计数:EditorHeader 每次 render 调一次 useT(design 层无 i18n,子组件不调)→ 包一层计数。

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const h = vi.hoisted(() => ({ renders: 0 }));

vi.mock('../../i18n', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../i18n')>();
  return {
    ...orig,
    useT: () => {
      h.renders += 1;
      return orig.useT();
    },
  };
});

import { EditorHeader, type TabChrome } from '../../panels/Editor/EditorHeader';
import { useEditorStore } from '../../stores/editor.store';

function tab(id: string, dirty = false) {
  return { id, filePath: id, content: 'x', originalContent: dirty ? 'y' : 'x', dirty };
}

beforeEach(() => {
  h.renders = 0;
  useEditorStore.setState({
    tabs: [tab('/a.ts', true), tab('/b.ts')],
    activeTabId: '/a.ts',
    mode: 'edit',
  });
});
afterEach(() => cleanup());

const stableClose = (_tab: TabChrome) => {};

function Harness() {
  const [n, setN] = useState(0);
  return (
    <>
      <button data-testid="bump" onClick={() => setN(n + 1)}>
        {n}
      </button>
      <EditorHeader onCloseRequest={stableClose} />
    </>
  );
}

describe('perf E3 — EditorHeader memo', () => {
  it('父级重渲且 props 不变 → EditorHeader 不重渲', () => {
    const { getByTestId } = render(<Harness />);
    const base = h.renders;
    expect(base).toBeGreaterThan(0);

    fireEvent.click(getByTestId('bump'));
    fireEvent.click(getByTestId('bump'));

    expect(getByTestId('bump').textContent).toBe('2');
    expect(h.renders).toBe(base);
  });

  it('自身订阅的 chrome 变化(新增 tab)→ 仍重渲并显示', () => {
    const { container } = render(<Harness />);
    const base = h.renders;

    act(() => {
      useEditorStore.getState().openTab(tab('/c.ts'));
    });

    expect(h.renders).toBeGreaterThan(base);
    expect(container.querySelectorAll('[role=tab]').length).toBe(3);
  });
});
