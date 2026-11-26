// BDD: editor-navigation-history 第 2 / 3 / 6 条 —— 导航栈语义(VSCode EditorNavigationStack)。见同目录 README。
import { describe, expect, it } from 'vitest';
import {
  EditorNavigationStack,
  NAVIGATION_STACK_MAX,
  type NavigationLocation,
} from '@/panels/Editor/navigation-stack';

const at = (path: string, line?: number, groupId = 'editor'): NavigationLocation =>
  line === undefined
    ? { groupId, path }
    : { groupId, path, selection: { line, column: 1, startLine: line } };
const lines = (s: EditorNavigationStack) => s.entries.map((e) => `${e.path}${e.selection ? `@${e.selection.line}` : ''}`);

describe('换编辑器', () => {
  it('每换一个编辑器记一条;同一编辑器只记文件(无光标)的重复通知不再记', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a'));
    s.notify(at('/a'));
    s.notify(at('/b'));
    expect(lines(s)).toEqual(['/a', '/b']);
    expect(s.index).toBe(1);
  });

  it('不同编辑器组里的同一文件是不同的编辑器', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a', 1, 'editor'));
    s.notify(at('/a', 1, 'editor:2'));
    expect(s.entries.map((e) => e.groupId)).toEqual(['editor', 'editor:2']);
  });
});

describe('同一文件内的光标', () => {
  it('移动 < 10 行:不新记,把当前这条更新成最新光标', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a', 1));
    s.notify(at('/a', 5));
    s.notify(at('/a', 9));
    expect(lines(s)).toEqual(['/a@9']);
  });

  it('连续小幅移动累计超过 10 行也不新记(比较的是上一次的位置)', () => {
    const s = new EditorNavigationStack();
    for (let line = 1; line <= 40; line++) s.notify(at('/a', line));
    expect(lines(s)).toEqual(['/a@40']);
  });

  it('移动 ≥ 10 行:新记一条(原位置保留)', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a', 1));
    s.notify(at('/a', 11));
    s.notify(at('/a', 300));
    expect(lines(s)).toEqual(['/a@1', '/a@11', '/a@300']);
  });

  it('只记文件的条目在第一次拿到光标时被替换(不多出一条)', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a', 3));
    s.notify(at('/b'));
    s.notify(at('/b', 200));
    expect(lines(s)).toEqual(['/a@3', '/b@200']);
  });
});

describe('上限与前进部分', () => {
  it(`最多 ${NAVIGATION_STACK_MAX} 条,超出丢最旧`, () => {
    expect(NAVIGATION_STACK_MAX).toBe(50);
    const s = new EditorNavigationStack();
    for (let i = 0; i < 60; i++) s.notify(at(`/f${i}`));
    expect(s.entries).toHaveLength(50);
    expect(s.entries[0]!.path).toBe('/f10');
    expect(s.index).toBe(49);
  });

  it('后退 / 前进沿栈移动,到头返回 undefined', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a'));
    s.notify(at('/b'));
    expect(s.canGoForward()).toBe(false);
    expect(s.back()?.path).toBe('/a');
    expect(s.canGoBack()).toBe(false);
    expect(s.back()).toBeUndefined();
    expect(s.forward()?.path).toBe('/b');
    expect(s.forward()).toBeUndefined();
  });

  it('后退后再产生新导航 → 清掉前进部分', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a'));
    s.notify(at('/b'));
    s.notify(at('/c'));
    const back = s.back()!;
    s.notify(back, true); // 执行后退落到 /b
    s.notify(at('/d'));
    expect(lines(s)).toEqual(['/a', '/b', '/d']);
    expect(s.canGoForward()).toBe(false);
  });

  it('执行导航期间的通知不记录(只更新当前位置)', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/a', 1));
    s.notify(at('/b', 1));
    s.back();
    s.notify(at('/a', 1), true);
    s.notify(at('/a', 1), true);
    expect(lines(s)).toEqual(['/a@1', '/b@1']);
    expect(s.index).toBe(0);
    // 之后小幅移动 → 替换的是后退落到的那条,不截断前进部分
    s.notify(at('/a', 4));
    expect(lines(s)).toEqual(['/a@4', '/b@1']);
    expect(s.canGoForward()).toBe(true);
  });
});

describe('原位替换(⌃Tab 连按)', () => {
  it('替换当前这条;与前一条成了同一位置则合并;栈空同普通记录', () => {
    const s = new EditorNavigationStack();
    s.replaceCurrent(at('/a'));
    expect(lines(s)).toEqual(['/a']);
    s.notify(at('/b'));
    s.replaceCurrent(at('/c'));
    expect(lines(s)).toEqual(['/a', '/c']);
    s.replaceCurrent(at('/a'));
    expect(lines(s)).toEqual(['/a']);
    expect(s.index).toBe(0);
  });
});

describe('文件被删除 / 移动', () => {
  it('删除:剔除该文件 / 目录下的条目,相邻重复合并,位置回到栈尾', () => {
    const s = new EditorNavigationStack();
    for (const p of ['/a', '/d/x', '/a', '/d/y', '/b']) s.notify(at(p));
    s.back();
    s.back();
    s.remove((p) => p === '/d' || p.startsWith('/d/'));
    expect(lines(s)).toEqual(['/a', '/b']);
    expect(s.index).toBe(1);
  });

  it('移动 / 改名:路径同前缀改写,相邻重复合并,当前位置跟随', () => {
    const s = new EditorNavigationStack();
    s.notify(at('/old/x', 1));
    s.notify(at('/new/x', 1)); // 改名后活动 tab 换了 id,先被当成换编辑器
    s.move('/old', '/new');
    expect(lines(s)).toEqual(['/new/x@1']);
    expect(s.index).toBe(0);
    s.notify(at('/new/x', 3));
    expect(lines(s)).toEqual(['/new/x@3']);
  });

  it('移动时位置落在被合并的条目上 → 落到合并后的那条', () => {
    const s = new EditorNavigationStack();
    for (const p of ['/a', '/b', '/c']) s.notify(at(p));
    s.back();
    s.move('/b', '/a');
    expect(lines(s)).toEqual(['/a', '/c']);
    expect(s.index).toBe(0);
  });
});
