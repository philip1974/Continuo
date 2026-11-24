// @vitest-environment jsdom
// tablist 方向键轮转在 popout 子窗里按 tablist 所在文档的焦点计算(handleTablistArrowKeys):读全局 document 时,子窗里
// 当前 tab 永远不在列表中 → → 总跳首项、← 总跳末项。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { handleTablistArrowKeys } from '../../design/roving-tablist';
import { makeChildDocument, type ChildDocument } from '../_helpers/child-document';

let child: ChildDocument | null = null;
afterEach(() => {
  child?.dispose();
  child = null;
});

describe('handleTablistArrowKeys · popout 子窗', () => {
  it('子窗中焦点在第 2 个 tab,→ 移到第 3 个(不回到第 1 个)', () => {
    child = makeChildDocument();
    const list = child.doc.createElement('div');
    list.setAttribute('role', 'tablist');
    const tabs = [0, 1, 2].map((i) => {
      const b = child!.doc.createElement('button');
      b.setAttribute('role', 'tab');
      b.textContent = `t${i}`;
      list.appendChild(b);
      return b;
    });
    child.host.appendChild(list);
    tabs[1]!.focus();
    expect(child.doc.activeElement).toBe(tabs[1]);
    handleTablistArrowKeys({
      key: 'ArrowRight',
      currentTarget: list,
      preventDefault: () => {},
    } as unknown as ReactKeyboardEvent<HTMLElement>);
    expect(child.doc.activeElement).toBe(tabs[2]);
  });
});

// dock tab 条键盘切换后焦点跟随:在 tab 所在文档里查找目标 tab(popout 子窗里全局 document 是主窗,找不到)。
describe('SharedTab 焦点跟随 · 源码接线', () => {
  it('按 rootRef 的 ownerDocument 查找目标 tab', () => {
    const src = readFileSync(join(process.cwd(), 'src/shell/motion/SharedTab.tsx'), 'utf-8');
    expect(src).toContain('rootRef.current?.ownerDocument');
    expect(src).not.toMatch(/document\.querySelector<HTMLElement>\(\s*`\[role="tab"\]\[data-panel-id/);
  });
});

