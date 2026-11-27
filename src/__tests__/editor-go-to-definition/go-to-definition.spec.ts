// @vitest-environment jsdom
// BDD: editor-go-to-definition —— TS / JS 转到定义(F12 / ⌘ 单击 / ⌘ 悬停)接真实 TypeScript 语言服务。见同目录 README。
// 链路:CodeMirror 视图(CodeEditor 的扩展)→ 命令注册表 → renderer 客户端(未保存文档同步)→ coApi.tsLanguage(替身:直接调 main 的
// ts-language.service)→ 语言服务进程(同进程替身:真实 ts-server-loop + ts-language-core + typescript)→ 跳转 / 选择器 / 提示 → 导航历史。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  request: null as null | ((input: unknown) => Promise<unknown>),
  listeners: new Set<(e: unknown) => void>(),
  readFile: null as null | ((p: string) => Promise<unknown>),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    tsLanguage: {
      request: (input: unknown) => h.request!(input),
      onEvent: (cb: (e: unknown) => void) => {
        h.listeners.add(cb);
        return () => h.listeners.delete(cb);
      },
    },
  },
}));
vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: (p: string) => h.readFile!(p), writeFile: vi.fn() } },
}));
vi.mock('../../panels/Editor/editor-engine-loaders', async (orig) => ({
  ...(await orig<object>()),
  preloadCodeEditorEngine: () => Promise.resolve(),
}));

import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { createTab, groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';
import { codeEditorTextCommands } from '@/panels/Editor/codemirror-text-commands';
import { navigationHistoryExtension } from '@/panels/Editor/codemirror-navigation-history';
import { definitionLinkRange, goToDefinitionExtension, isDefinitionModifier } from '@/panels/Editor/codemirror-go-to-definition';
import { installNavigationHistory, navigateBack, resetNavigationHistory } from '@/panels/Editor/navigation-history';
import { _resetTsLanguageClientForTest } from '@/panels/Editor/ts-language-client';
import { useDefinitionPickerStore } from '@/plugins/definition-picker/store';
import { goToLocation } from '@/panels/Editor/go-to-definition';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { createTsLanguageService, type TsServerChild } from '../../../electron/main/services/ts-language.service';
import { createTsServerLoop } from '../../../electron/main/ts-language/ts-server-loop';
import type { TsServerRequest } from '../../../electron/main/ts-language/ts-server-protocol';
import type { TsRequestInput } from '../../../electron/shared/ts-language';

/** 语言服务进程的同进程替身:消息异步往返,可模拟崩溃。 */
class InProcessServer implements TsServerChild {
  private dead = false;
  private onMsg: ((m: unknown) => void) | null = null;
  private onEnd: ((code: number) => void) | null = null;
  private readonly loop = createTsServerLoop((m) => {
    setTimeout(() => {
      if (!this.dead) this.onMsg?.(m);
    }, 0);
  });
  postMessage(m: TsServerRequest) {
    if (!this.dead) this.loop.handle(structuredClone(m));
  }
  onMessage(cb: (m: unknown) => void) {
    this.onMsg = cb;
  }
  onExit(cb: (code: number) => void) {
    this.onEnd = cb;
  }
  kill() {
    this.dead = true;
    this.onEnd?.(0);
  }
  crash() {
    this.dead = true;
    this.onEnd?.(1);
  }
}

let ws: string;
let servers: InProcessServer[];
let service: ReturnType<typeof createTsLanguageService>;
let requests: TsRequestInput[];
const WIN = { id: 1, send: (_c: string, payload: unknown) => h.listeners.forEach((cb) => cb(payload)) };

const st = () => useEditorStore.getState();
const activeTab = () => groupActiveTabIdOf(st(), st().activeGroupId);
const P = (rel: string) => path.join(ws, rel);
function write(rel: string, text: string): string {
  mkdirSync(path.dirname(P(rel)), { recursive: true });
  writeFileSync(P(rel), text);
  return P(rel);
}

const B_TS = ['// helpers', '', 'export function helper(): number {', '  return 1;', '}', '', 'export default class Main {', '  run(): void {}', '}', ''].join('\n');
const BARREL_TS = "export { deep } from './deep';\n";
const DEEP_TS = '\n\nexport const deep = 42;\n';
const A_TS = [
  "import Main, { helper } from './b';",
  "import { deep } from './barrel';",
  "import { fake } from 'fakepkg';",
  '',
  'const local = 1;',
  'local;',
  'helper();',
  'new Main().run();',
  'deep;',
  'fake();',
  'interface Merged { a: number }',
  'interface Merged { b: number }',
  'let m: Merged;',
  ...Array.from({ length: 10 }, (_, i) => `// pad ${i + 1}`),
  'local; // far',
  '',
].join('\n');

const views = new Map<string, EditorView>();
function mountView(tabId: string, doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const lang = tabId.endsWith('.md') ? markdown() : javascript({ typescript: true });
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        codeEditorBasicSetup,
        codeEditorTextCommands(),
        lang,
        navigationHistoryExtension(tabId, 'editor'),
        goToDefinitionExtension(() => tabId),
        // jsdom 无布局:CodeMirror 自己的鼠标选择(按下后量坐标)跑不了,按下事件到此为止(转到定义的观察者先于它运行)
        EditorView.domEventHandlers({ mousedown: () => true }),
        // CodeEditor 的受控回写:编辑即写进 store(未保存内容)
        EditorView.updateListener.of((u) => {
          if (u.docChanged) st().updateContent(tabId, u.state.doc.toString());
        }),
      ],
    }),
    parent,
  });
  st().registerView(tabId, view, 'editor');
  views.set(tabId, view);
  return view;
}
/** 编辑器面板的替身:活动 tab 变了且未挂载 → 挂载其视图。 */
function autoMount(): () => void {
  return useEditorStore.subscribe((s, prev) => {
    const id = s.activeTabId;
    if (id === prev.activeTabId || !id || views.has(id)) return;
    const tab = s.tabs.find((x) => x.id === id);
    queueMicrotask(() => {
      if (tab && !views.has(id)) mountView(id, tab.content);
    });
  });
}
function openInEditor(rel: string): EditorView {
  const p = P(rel);
  const content = readFileSync(p, 'utf8');
  st().openTab(createTab(p, content), { groupId: 'editor' });
  return mountView(p, content);
}
const cursor = (view: EditorView) => {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
};
function placeCursor(view: EditorView, needle: string, offset = 1): number {
  const pos = view.state.doc.toString().indexOf(needle) + offset;
  view.dispatch({ selection: EditorSelection.cursor(pos) });
  return pos;
}
const reveal = () => coApp.commands.execute('editor.action.revealDefinition');
const definitionRequests = () => requests.filter((r) => r.op.kind === 'definition');

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let stopAutoMount = () => {};
let uninstallNav = () => {};

beforeAll(() => {
  bootCorePlugins();
  uninstallNav = installNavigationHistory();
});
afterAll(() => {
  uninstallNav();
  shutdownCorePlugins();
});

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'ui158-gtd-')));
  write('tsconfig.json', '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}');
  write('b.ts', B_TS);
  write('barrel.ts', BARREL_TS);
  write('deep.ts', DEEP_TS);
  write('a.ts', A_TS);
  write('node_modules/fakepkg/package.json', '{"name":"fakepkg","types":"index.d.ts"}');
  write('node_modules/fakepkg/index.d.ts', 'export declare function fake(): void;\n');
  write('notes.md', '# notes\n\nhelper\n');

  servers = [];
  requests = [];
  service = createTsLanguageService({
    spawn: () => {
      const s = new InProcessServer();
      servers.push(s);
      return s;
    },
  });
  h.request = async (input) => {
    requests.push(structuredClone(input) as TsRequestInput);
    return { ok: true, data: await service.request(WIN, ws, structuredClone(input) as TsRequestInput) };
  };
  h.readFile = async (p) => ({ ok: true, data: readFileSync(p, 'utf8') });
  _resetTsLanguageClientForTest();
  useWorkspaceStore.setState({ root: ws });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  useDefinitionPickerStore.getState().close();
  resetNavigationHistory();
  info = vi.spyOn(notify, 'info').mockImplementation(() => {});
  warn = vi.spyOn(notify, 'warn').mockImplementation(() => {});
  stopAutoMount = autoMount();
});

afterEach(() => {
  stopAutoMount();
  service.dispose(WIN.id);
  vi.restoreAllMocks();
  for (const [tabId, view] of views) {
    st().unregisterView(tabId, view);
    view.destroy();
  }
  views.clear();
  document.body.innerHTML = '';
  rmSync(ws, { recursive: true, force: true });
});

const TIMEOUT = { timeout: 4000 };

describe('F12 转到定义:一个结果 → 跳转,⌃- 退回', () => {
  it('同文件:光标移到定义名开头;⌃- 回到原处', async () => {
    const a = openInEditor('a.ts');
    placeCursor(a, 'local; // far', 2);
    await reveal();
    await vi.waitFor(() => expect(cursor(a)).toEqual({ line: 5, column: 7 }), TIMEOUT);
    await navigateBack();
    expect(cursor(a)).toEqual({ line: 24, column: 3 });
  });

  it('跨文件:在当前组打开 b.ts,光标到 `helper` 声明;⌃- 回到 a.ts 原处', async () => {
    const a = openInEditor('a.ts');
    placeCursor(a, 'helper();', 2);
    await reveal();
    await vi.waitFor(() => expect(activeTab()).toBe(P('b.ts')), TIMEOUT);
    await vi.waitFor(() => expect(cursor(views.get(P('b.ts'))!)).toEqual({ line: 3, column: 17 }), TIMEOUT);
    await navigateBack();
    await vi.waitFor(() => expect(activeTab()).toBe(P('a.ts')));
    expect(cursor(a)).toEqual({ line: 7, column: 3 });
  });

  it.each([
    ['import 路径字符串', "'./b'", 2, 'b.ts', { line: 1, column: 1 }],
    ['默认导出', 'Main().run', 1, 'b.ts', { line: 7, column: 22 }],
    ['成员方法', 'run();', 1, 'b.ts', { line: 8, column: 3 }],
    ['重导出(barrel → 原始声明)', 'deep;', 1, 'deep.ts', { line: 3, column: 14 }],
    ['node_modules 假包的 .d.ts', 'fake();', 1, 'node_modules/fakepkg/index.d.ts', { line: 1, column: 25 }],
  ])('%s', async (_name, needle, offset, target, at) => {
    const a = openInEditor('a.ts');
    placeCursor(a, needle, offset);
    await reveal();
    await vi.waitFor(() => expect(activeTab()).toBe(P(target)), TIMEOUT);
    await vi.waitFor(() => expect(cursor(views.get(P(target))!)).toEqual(at), TIMEOUT);
  });
});

describe('未保存的修改', () => {
  it('本文件:编辑后不保存,定义位置按编辑后的内容', async () => {
    const a = openInEditor('a.ts');
    a.dispatch({ changes: { from: a.state.doc.line(5).from, insert: '// x\n// y\n' } });
    expect(st().tabs.find((x) => x.id === P('a.ts'))?.dirty).toBe(true);
    placeCursor(a, 'local;', 2);
    await reveal();
    await vi.waitFor(() => expect(cursor(a)).toEqual({ line: 7, column: 7 }), TIMEOUT);
  });

  it('别的文件:b.ts 未保存的修改也生效;第二次请求只带版本号不重发全文', async () => {
    const b = openInEditor('b.ts');
    b.dispatch({ changes: { from: 0, insert: '\n\n\n' } });
    const a = openInEditor('a.ts');
    placeCursor(a, 'helper();', 2);
    await reveal();
    await vi.waitFor(() => expect(cursor(views.get(P('b.ts'))!)).toEqual({ line: 6, column: 17 }), TIMEOUT);
    const withText = definitionRequests().flatMap((r) => r.docs.filter((d) => d.text !== undefined).map((d) => d.path));
    expect(withText).toEqual([P('b.ts')]);
    st().switchTab(P('a.ts'));
    await reveal();
    await vi.waitFor(() => expect(definitionRequests()).toHaveLength(2), TIMEOUT);
    expect(definitionRequests()[1]!.docs).toEqual([{ path: P('b.ts'), version: expect.any(Number) }]);
  });
});

describe('多个结果 → 选择器', () => {
  it('声明合并的 interface:选择器列出两处(预览 + 行),选第二个跳过去', async () => {
    const a = openInEditor('a.ts');
    placeCursor(a, 'Merged;', 1);
    await reveal();
    await vi.waitFor(() => expect(useDefinitionPickerStore.getState().isOpen).toBe(true), TIMEOUT);
    const locs = useDefinitionPickerStore.getState().locations;
    expect(locs.map((l) => [l.line, l.preview])).toEqual([
      [11, 'interface Merged { a: number }'],
      [12, 'interface Merged { b: number }'],
    ]);
    expect(cursor(a).line).toBe(13); // 选之前不动
    await goToLocation(locs[1]!);
    expect(cursor(a)).toEqual({ line: 12, column: 11 });
  });
});

describe('没有定义', () => {
  it('F12 在关键字 / 空白处 → VSCode「未找到定义」提示,不跳转', async () => {
    const a = openInEditor('a.ts');
    placeCursor(a, 'const local', 2);
    await reveal();
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(t('editor.definition.none_for', { name: 'const' })), TIMEOUT);
    expect(cursor(a).line).toBe(5);
  });
});

describe('⌘ 单击 / ⌘ 悬停(Windows / Linux 为 Ctrl)', () => {
  function mouse(view: EditorView, type: string, init: MouseEventInit) {
    view.contentDOM.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5, ...init }));
  }

  it('按住修饰键悬停在可跳转的标识符上 → 下划线(语言服务给的区间);松开修饰键 → 消失', async () => {
    const a = openInEditor('a.ts');
    const pos = a.state.doc.toString().indexOf('helper();') + 2;
    a.posAtCoords = () => pos;
    mouse(a, 'mousemove', { ctrlKey: true });
    await vi.waitFor(() => expect(a.contentDOM.querySelector('.cm-definition-link')?.textContent).toBe('helper'), TIMEOUT);
    // 原地补发的 mousemove(Chromium 布局变化后补发,修饰键状态不可靠)不算移开
    mouse(a, 'mousemove', {});
    expect(definitionLinkRange(a)).not.toBeNull();
    a.contentDOM.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    expect(definitionLinkRange(a)).toBeNull();
    expect(a.contentDOM.querySelector('.cm-definition-link')).toBeNull();
  });

  it('不按修饰键移开 → 下划线消失', async () => {
    const a = openInEditor('a.ts');
    const pos = a.state.doc.toString().indexOf('helper();') + 2;
    a.posAtCoords = () => pos;
    mouse(a, 'mousemove', { ctrlKey: true });
    await vi.waitFor(() => expect(definitionLinkRange(a)).not.toBeNull(), TIMEOUT);
    mouse(a, 'mousemove', { clientX: 40 });
    expect(definitionLinkRange(a)).toBeNull();
  });

  it('修饰键:mac 为 ⌘,Windows / Linux 为 Ctrl;带 ⌥(加光标)/ ⇧ 不算', () => {
    const k = (o: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>>) => ({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...o,
    });
    expect(isDefinitionModifier(k({ metaKey: true }), true)).toBe(true);
    expect(isDefinitionModifier(k({ ctrlKey: true }), true)).toBe(false);
    expect(isDefinitionModifier(k({ ctrlKey: true }), false)).toBe(true);
    expect(isDefinitionModifier(k({ metaKey: true }), false)).toBe(false);
    expect(isDefinitionModifier(k({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isDefinitionModifier(k({ altKey: true }), true)).toBe(false);
    expect(isDefinitionModifier(k({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it('没按修饰键 / 不可跳转处(关键字)→ 不加下划线', async () => {
    const a = openInEditor('a.ts');
    const pos = a.state.doc.toString().indexOf('const local') + 2;
    a.posAtCoords = () => pos;
    mouse(a, 'mousemove', {});
    mouse(a, 'mousemove', { ctrlKey: true });
    await vi.waitFor(() => expect(definitionRequests().length).toBe(1), TIMEOUT);
    await new Promise((r) => setTimeout(r, 50));
    expect(definitionLinkRange(a)).toBeNull();
  });

  it('修饰键单击标识符 → 跳到定义;单击无定义处静默(不提示)', async () => {
    const a = openInEditor('a.ts');
    const pos = a.state.doc.toString().indexOf('helper();') + 2;
    a.posAtCoords = () => pos;
    mouse(a, 'mousedown', { ctrlKey: true, button: 0 });
    mouse(a, 'mouseup', { ctrlKey: true, button: 0 });
    await vi.waitFor(() => expect(activeTab()).toBe(P('b.ts')), TIMEOUT);

    st().switchTab(P('a.ts'));
    const kw = a.state.doc.toString().indexOf('const local') + 2;
    a.posAtCoords = () => kw;
    mouse(a, 'mousedown', { ctrlKey: true, button: 0 });
    mouse(a, 'mouseup', { ctrlKey: true, button: 0 });
    await vi.waitFor(() => expect(definitionRequests().length).toBe(2), TIMEOUT);
    await new Promise((r) => setTimeout(r, 50));
    expect(info).not.toHaveBeenCalled();
    expect(activeTab()).toBe(P('a.ts'));
  });
});

describe('非 TS / JS 文件不受影响', () => {
  it('Markdown:F12 照旧提示、修饰键单击 / 悬停不请求语言服务', async () => {
    const md = openInEditor('notes.md');
    const pos = placeCursor(md, 'helper', 2);
    await reveal();
    expect(info).toHaveBeenCalledWith(t('editor.definition.none_for', { name: 'helper' }));
    md.posAtCoords = () => pos;
    for (const type of ['mousemove', 'mousedown', 'mouseup']) {
      md.contentDOM.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey: true, button: 0 }));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(requests).toEqual([]);
    expect(servers).toEqual([]);
  });
});

describe('服务进程', () => {
  it('打开 TS 文件即预热(启动服务)', async () => {
    openInEditor('a.ts');
    await vi.waitFor(() => expect(requests.map((r) => r.op.kind)).toEqual(['warmup']), TIMEOUT);
    expect(servers).toHaveLength(1);
  });

  it('崩溃 → 提示「JS/TS 语言服务已崩溃」;下次 F12 自动重启并按未保存内容跳转', async () => {
    const a = openInEditor('a.ts');
    await vi.waitFor(() => expect(servers).toHaveLength(1), TIMEOUT);
    a.dispatch({ changes: { from: a.state.doc.line(5).from, insert: '\n' } });
    placeCursor(a, 'local;', 2);
    await reveal();
    await vi.waitFor(() => expect(cursor(a).line).toBe(6), TIMEOUT);
    servers[0]!.crash();
    expect(warn).toHaveBeenCalledWith(t('editor.ts_server.crashed'));
    placeCursor(a, 'local;', 2);
    await reveal();
    await vi.waitFor(() => expect(cursor(a)).toEqual({ line: 6, column: 7 }), TIMEOUT);
    expect(servers).toHaveLength(2);
  });
});
