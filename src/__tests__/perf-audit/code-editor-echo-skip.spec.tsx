// @vitest-environment jsdom
// perf-audit P6 · CodeEditor 受控回声跳过全文 toString。
//
// 本地打字:updateListener `doc.toString()` emit 给 onChange(必要),父 store 更新后
// 把同一字符串作为 value 回传 → value-sync effect 旧实现再 `doc.toString()` 比较一次
// (回声),长文件每按键 2 次 O(file) 拷贝。P6:lastSyncedValueRef 记下 emit 值,effect
// `value === lastSynced` 直接跳过,连 toString 都省;真正的外部新值(≠ lastSynced)仍
// 正常 toString + dispatch 同步。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

const views = new Map<string, unknown>();
vi.mock('@/stores/editor.store', () => ({
  useEditorStore: Object.assign(() => undefined, {
    getState: () => ({
      registerView: (id: string, v: unknown) => views.set(id, v),
      unregisterView: (id: string) => views.delete(id),
    }),
  }),
}));

import { CodeEditor, fileExtensionLower } from '../../panels/Editor/CodeEditor';
import type { EditorView } from 'codemirror';

afterEach(() => {
  cleanup();
  views.clear();
});

describe('perf-audit P6 · CodeEditor 受控回声免全文 toString', () => {
  it('文件扩展名推断不通过 split/pop 分配数组', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(fileExtensionLower('/repo/src/app.TSX')).toBe('tsx');
      expect(fileExtensionLower('/repo/README')).toBeUndefined();
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });

  it('回声(value === 上次 emit)→ effect 跳过,不再 doc.toString();非回声 → 正常同步', () => {
    const emitted: string[] = [];
    const onChange = (v: string) => emitted.push(v);
    const { rerender } = render(
      <CodeEditor tabId="t1" value="hello" fileName="a.js" onChange={onChange} />,
    );
    const view = views.get('t1') as EditorView;
    expect(view).toBeTruthy();

    // 模拟用户输入 → updateListener docChanged → onChange emit 新全文
    view.dispatch({ changes: { from: 5, insert: ' world' } });
    const echo = emitted.at(-1);
    expect(echo).toBe('hello world');

    // 受控回声:父把 emit 的值作为 value 回传。effect 应命中 lastSynced 直接 return,
    // 不调用当前 doc 的 toString(P6 的核心收益)。
    const docSpy = vi.spyOn(view.state.doc, 'toString');
    rerender(
      <CodeEditor tabId="t1" value={echo!} fileName="a.js" onChange={onChange} />,
    );
    expect(docSpy).not.toHaveBeenCalled();
    // doc 未被多余 dispatch 改动
    expect(view.state.doc.toString()).toBe('hello world');

    // 反例:真正的外部新值(≠ lastSynced)→ 不跳过 → 现场 toString 比较 + dispatch 同步。
    const docSpy2 = vi.spyOn(view.state.doc, 'toString');
    rerender(
      <CodeEditor
        tabId="t1"
        value="external change"
        fileName="a.js"
        onChange={onChange}
      />,
    );
    expect(docSpy2).toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('external change');
  });
});
