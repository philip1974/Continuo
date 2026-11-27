// @vitest-environment jsdom
// BDD:popout 子窗打开后,主窗 <head> 后加入 / 移除 / 改写的样式同步到每个子窗(懒加载 chunk 的 CSS)。见同目录 README S1-S4。
import type { DockviewApi } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackPopoutDocuments } from '@/shell/dock/popout-documents';
import { trackPopoutStylesheets } from '@/shell/dock/popout-stylesheets';
import { makeChildDocument, type ChildDocument } from '../_helpers/child-document';

type Listener = () => void;
function emitter() {
  const ls = new Set<Listener>();
  return {
    on: (l: Listener) => {
      ls.add(l);
      return { dispose: () => ls.delete(l) };
    },
    fire: () => {
      for (const l of [...ls]) l();
    },
  };
}

// 只实现 trackPopoutDocuments 用到的 dockview api 子集。
function fakeDock() {
  const added = emitter();
  const groups: Array<{ api: { location: unknown; onDidLocationChange: (l: Listener) => { dispose: () => void } } }> = [];
  const api = {
    get groups() {
      return groups;
    },
    onDidAddGroup: added.on,
    onDidRemoveGroup: emitter().on,
  };
  return {
    api: api as unknown as DockviewApi,
    addGroup(location: unknown) {
      const move = emitter();
      const g = { api: { location, onDidLocationChange: move.on } };
      groups.push(g);
      added.fire();
      return {
        moveTo(next: unknown) {
          g.api.location = next;
          move.fire();
        },
      };
    },
  };
}

const popoutOf = (c: ChildDocument) => ({ type: 'popout', getWindow: () => c.win });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const added: Element[] = [];
const children: ChildDocument[] = [];
const disposers: Array<{ dispose: () => void }> = [];

function addToMainHead<T extends Element>(el: T): T {
  document.head.appendChild(el);
  added.push(el);
  return el;
}
function mainLink(href: string, rel = 'stylesheet'): HTMLLinkElement {
  const l = document.createElement('link');
  l.rel = rel;
  l.href = href;
  return addToMainHead(l);
}
function mainStyle(css: string): HTMLStyleElement {
  const s = document.createElement('style');
  s.textContent = css;
  return addToMainHead(s);
}
const childLinks = (c: ChildDocument) =>
  [...c.doc.head.querySelectorAll('link')].map((l) => `${l.rel} ${l.href}`);
const childStyles = (c: ChildDocument) => [...c.doc.head.querySelectorAll('style')].map((s) => s.textContent);

/** 打开 n 个 popout 子窗并开始同步样式(DockShell onReady 的挂载顺序)。 */
function setup(n = 1) {
  const dock = fakeDock();
  disposers.push(trackPopoutDocuments(dock.api), trackPopoutStylesheets());
  const wins = Array.from({ length: n }, () => {
    const c = makeChildDocument();
    children.push(c);
    return { child: c, group: dock.addGroup(popoutOf(c)) };
  });
  return { dock, wins };
}

beforeEach(() => {
  added.length = 0;
});
afterEach(() => {
  for (const d of disposers.splice(0)) d.dispose();
  for (const c of children.splice(0)) c.dispose();
  for (const el of added) el.remove();
});

describe('popout 子窗跟随主窗后加载的样式', () => {
  it('S1 开窗后主窗新增 <link rel=stylesheet> → 子窗出现同一绝对地址的 link', async () => {
    const { wins } = setup();
    const child = wins[0]!.child;
    const link = mainLink('/assets/MilkdownEditor-abc.css');
    await flush();
    expect(childLinks(child)).toEqual([`stylesheet ${link.href}`]);
  });

  it('S2 新增 <style> → 克隆;改写文本 → 克隆更新;移除 → 克隆移除', async () => {
    const { wins } = setup();
    const child = wins[0]!.child;
    const style = mainStyle('.milkdown h1 { font-weight: 700; }');
    await flush();
    expect(childStyles(child)).toEqual(['.milkdown h1 { font-weight: 700; }']);

    style.textContent = '.milkdown h1 { font-weight: 800; }';
    await flush();
    expect(childStyles(child)).toEqual(['.milkdown h1 { font-weight: 800; }']);

    style.remove();
    await flush();
    expect(childStyles(child)).toEqual([]);
  });

  it('S3 不重复:开窗时已有的 <style> 不克隆;子窗已有同 href 的 link 不再加;开窗时子窗缺的 link 补上', async () => {
    mainStyle('.early { color: red; }');
    const copied = mainLink('/assets/index.css');
    const missed = mainLink('/assets/still-loading.css');
    const dock = fakeDock();
    disposers.push(trackPopoutDocuments(dock.api), trackPopoutStylesheets());
    const child = makeChildDocument();
    children.push(child);
    // dockview 开窗时抄过的:主窗已加载的 link + 已有 <style> 的规则
    const pre = child.doc.createElement('link');
    pre.rel = 'stylesheet';
    pre.href = copied.href;
    child.doc.head.appendChild(pre);
    dock.addGroup(popoutOf(child));
    await flush();

    expect(childLinks(child)).toEqual([`stylesheet ${copied.href}`, `stylesheet ${missed.href}`]);
    expect(childStyles(child)).toEqual([]);

    // 主窗再插一个子窗已有的 href(另一 chunk 重复预加载)→ 不重复
    mainLink('/assets/index.css');
    await flush();
    expect(childLinks(child)).toHaveLength(2);
  });

  it('S3 已有子窗时主窗刚插入 <style>、随即又开新子窗(dockview 已抄过它)→ 新子窗不重复克隆', async () => {
    const { dock, wins } = setup();
    mainStyle('.racing {}'); // 变更记录尚未投递
    const late = makeChildDocument();
    children.push(late);
    late.doc.head.appendChild(late.doc.createElement('style')).textContent = '.racing {}'; // dockview addStyles 的副本
    dock.addGroup(popoutOf(late));
    await flush();
    expect(childStyles(wins[0]!.child)).toEqual(['.racing {}']);
    expect(childStyles(late)).toEqual(['.racing {}']);
  });

  it('S3 非样式 link(modulepreload)与 <title> 变化不同步', async () => {
    const { wins } = setup();
    const child = wins[0]!.child;
    mainLink('/assets/chunk.js', 'modulepreload');
    const before = document.title;
    document.title = 'changed';
    await flush();
    document.title = before;
    expect(childLinks(child)).toEqual([]);
    expect(child.doc.title).not.toBe('changed');
  });

  it('S4 多个子窗各自同步;子窗关闭后不再写它;dispose 后停止', async () => {
    const { wins } = setup(2);
    const [a, b] = wins as [(typeof wins)[0], (typeof wins)[0]];
    mainStyle('.one {}');
    await flush();
    expect(childStyles(a.child)).toEqual(['.one {}']);
    expect(childStyles(b.child)).toEqual(['.one {}']);

    a.group.moveTo({ type: 'grid' }); // 组收回主窗 → 子窗关闭
    mainStyle('.two {}');
    await flush();
    expect(childStyles(a.child)).toEqual(['.one {}']);
    expect(childStyles(b.child)).toEqual(['.one {}', '.two {}']);

    for (const d of disposers.splice(0)) d.dispose();
    mainStyle('.three {}');
    await flush();
    expect(childStyles(b.child)).toEqual(['.one {}', '.two {}']);
  });
});
