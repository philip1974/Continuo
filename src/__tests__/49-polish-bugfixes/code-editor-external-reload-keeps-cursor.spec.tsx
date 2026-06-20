// @vitest-environment jsdom
// topic 49 第十五轮 · P2-AQ:外部修改触发 reload 时 CodeEditor 保留光标/选区。
//
// 根因:CodeEditor 的 value-sync effect 在 value 变化(外部 reloadFromDisk)时用
// `dispatch({changes:{from:0,to:doc.length,insert:value}})` 整篇替换,**不带 selection**。
// CodeMirror 全文替换不带 selection 会把光标甩到文档边界。用户正在 .js/.json 或 markdown
// Source 模式文件中部阅读/定位时,外部进程改盘 → 光标跳回顶部。Milkdown 走 epoch-remount
// 是有意设计,但 CodeEditor 这条「就地 dispatch」路径漏了 selection 保持。
// 修复:把旧 selection clamp 到新长度后随 dispatch 一并提交。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

const views = new Map<string, unknown>();
vi.mock('@/stores/editor.store', () => ({
  useEditorStore: Object.assign(
    () => undefined,
    {
      getState: () => ({
        registerView: (id: string, v: unknown) => views.set(id, v),
        unregisterView: (id: string) => views.delete(id),
      }),
    },
  ),
}));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import type { EditorView } from 'codemirror';

afterEach(() => {
  cleanup();
  views.clear();
});

describe('topic49 P2-AQ · CodeEditor 外部 reload 保留光标', () => {
  it('value 外部变化(内容仍包含原光标位置)→ 光标位置保留,不归零', () => {
    const initial = 'line0\nline1\nline2\nline3\n';
    const { rerender } = render(
      <CodeEditor tabId="t1" value={initial} fileName="a.js" />,
    );
    const view = views.get('t1') as EditorView;
    expect(view).toBeTruthy();

    // 把光标放到文档中部(第 12 个字符,约 line2 处)
    view.dispatch({ selection: { anchor: 12, head: 12 } });
    expect(view.state.selection.main.head).toBe(12);

    // 外部进程在末尾追加内容 → reloadFromDisk 更新 value
    const external = initial + 'line4\nline5\n';
    rerender(<CodeEditor tabId="t1" value={external} fileName="a.js" />);

    // 内容已更新
    expect(view.state.doc.toString()).toBe(external);
    // 关键:光标仍在 12(没被甩到 0 或文档末尾)
    expect(view.state.selection.main.head).toBe(12);
  });

  it('外部内容变短:光标 clamp 到新长度(不越界)', () => {
    const initial = 'aaaaaaaaaaaaaaaaaaaa'; // 20 chars
    const { rerender } = render(
      <CodeEditor tabId="t2" value={initial} fileName="b.txt" />,
    );
    const view = views.get('t2') as EditorView;
    view.dispatch({ selection: { anchor: 18, head: 18 } });

    const external = 'bbb'; // 3 chars，光标 18 越界
    rerender(<CodeEditor tabId="t2" value={external} fileName="b.txt" />);

    expect(view.state.doc.toString()).toBe(external);
    // clamp 到 3,不抛 RangeError、不越界
    expect(view.state.selection.main.head).toBe(3);
  });
});
