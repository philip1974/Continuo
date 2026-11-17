// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mermaidMock = vi.hoisted(() => ({
  loaded: 0,
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => {
  mermaidMock.loaded += 1;
  return {
    default: {
      initialize: mermaidMock.initialize,
      render: mermaidMock.render,
    },
  };
});

type MermaidPreviewModule = typeof import('../../panels/Editor/mermaid-preview');

// 每个用例拿一份全新的模块(懒加载单例 / 渲染队列是模块级状态);`t` 取自同一份模块图,
// 保证与被测模块用同一个 locale。
async function loadModule(): Promise<
  MermaidPreviewModule & { t: typeof import('../../i18n').t }
> {
  vi.resetModules();
  const mod = await import('../../panels/Editor/mermaid-preview');
  const { t } = await import('../../i18n');
  return { ...mod, t };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mermaidMock.loaded = 0;
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
  mermaidMock.render.mockImplementation(async (id: string, code: string) => ({
    svg: `<svg id="${id}"><text>${code}</text></svg>`,
  }));
  document.documentElement.classList.add('dark');
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('style');
  document.body.innerHTML = '';
});

const TOKENS: Record<string, string> = {
  '--md-surface-container': '#1d1f27',
  '--md-surface-container-low': '#191b23',
  '--md-surface-container-high': '#282a32',
  '--md-surface-container-highest': '#33353d',
  '--md-on-surface': '#e1e2ed',
  '--md-on-surface-variant': '#c3c6d7',
  '--md-outline': '#8d90a0',
};

function setTokens(overrides: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries({ ...TOKENS, ...overrides })) {
    document.documentElement.style.setProperty(name, value);
  }
}

describe('renderMermaidPreview', () => {
  it('returns null for other languages without loading mermaid', async () => {
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    expect(renderMermaidPreview('js', 'const a = 1;', apply)).toBeNull();
    expect(renderMermaidPreview('', 'graph TD', apply)).toBeNull();
    await flush();

    expect(apply).not.toHaveBeenCalled();
    expect(mermaidMock.loaded).toBe(0);
  });

  it('returns null for blank mermaid content', async () => {
    const { renderMermaidPreview } = await loadModule();

    expect(renderMermaidPreview('mermaid', '  \n', vi.fn())).toBeNull();
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it('renders mermaid blocks asynchronously into the preview', async () => {
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    expect(renderMermaidPreview('Mermaid', 'graph TD\n  A-->B', apply)).toBeUndefined();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    const html = apply.mock.calls[0]![0] as string;
    expect(html).toContain('<svg');
    expect(html).toContain('graph TD');
  });

  it('initializes mermaid once with the hardened static-SVG config', async () => {
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    renderMermaidPreview('mermaid', 'graph TD\n  B-->C', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);
    expect(mermaidMock.initialize.mock.calls[0]![0]).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: 'dark',
    });
  });

  it('locks the hardening against in-diagram %%{init}%% directives', async () => {
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    const secure = (
      mermaidMock.initialize.mock.calls[0]![0] as { secure: string[] }
    ).secure;
    expect(secure).toEqual(
      expect.arrayContaining([
        // mermaid 默认项(传 secure 会整体替换默认值,必须带上)
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        // 本项目追加:不许图表把标签切回 foreignObject / 注入可发外部请求的 CSS
        'htmlLabels',
        'themeCSS',
      ]),
    );
  });

  it('colors diagrams from the app design tokens', async () => {
    setTokens();
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    expect(mermaidMock.initialize.mock.calls[0]![0]).toMatchObject({
      theme: 'base',
      themeVariables: {
        darkMode: true,
        background: '#1d1f27',
        primaryColor: '#282a32',
        primaryTextColor: '#e1e2ed',
        primaryBorderColor: '#8d90a0',
        lineColor: '#c3c6d7',
      },
    });
  });

  it('re-initializes when the theme (tokens) changes', async () => {
    setTokens();
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    document.documentElement.classList.remove('dark');
    setTokens({ '--md-surface-container': '#f2ecf4', '--md-on-surface': '#1d1b20' });
    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    expect(mermaidMock.initialize).toHaveBeenCalledTimes(2);
    expect(mermaidMock.initialize.mock.calls[1]![0]).toMatchObject({
      theme: 'base',
      themeVariables: {
        darkMode: false,
        background: '#f2ecf4',
        primaryTextColor: '#1d1b20',
      },
    });
  });

  it('falls back to the built-in dark / default theme when tokens are unavailable', async () => {
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    document.documentElement.classList.remove('dark');
    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    expect(mermaidMock.initialize.mock.calls[0]![0]).toMatchObject({ theme: 'dark' });
    expect(mermaidMock.initialize.mock.calls[1]![0]).toMatchObject({ theme: 'default' });
  });

  it('uses a distinct svg id for every render', async () => {
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    const ids = mermaidMock.render.mock.calls.map((c) => c[0] as string);
    expect(new Set(ids).size).toBe(2);
  });

  it('shows a localized, escaped error instead of throwing on bad syntax', async () => {
    mermaidMock.render.mockRejectedValueOnce(
      new Error('Parse error <img src=x onerror=alert(1)>'),
    );
    const { renderMermaidPreview, t } = await loadModule();
    const apply = vi.fn();

    expect(renderMermaidPreview('mermaid', 'graph TD\n  A--', apply)).toBeUndefined();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    const html = apply.mock.calls[0]![0] as string;
    expect(html).toContain(t('panels.editor.mermaid.renderError'));
    expect(html).toContain('Parse error &lt;img');
    expect(html).not.toContain('<img');
  });

  it('keeps rendering later blocks after a failed one', async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error('boom'));
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'bad', apply);
    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    expect(apply.mock.calls[1]![0]).toContain('<svg');
  });

  it('applies previews in request order even when an earlier render is slower', async () => {
    let releaseFirst: (() => void) | null = null;
    mermaidMock.render.mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ svg: `<svg id="${id}">first</svg>` });
        }),
    );
    const { renderMermaidPreview } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    renderMermaidPreview('mermaid', 'graph TD\n  A-->C', apply);
    await vi.waitFor(() => expect(releaseFirst).not.toBeNull());
    await flush();
    expect(apply).not.toHaveBeenCalled();

    releaseFirst!();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    expect(apply.mock.calls[0]![0]).toContain('first');
    expect(apply.mock.calls[1]![0]).toContain('A-->C');
  });

  it('does not resurrect a stale diagram after the block stopped being mermaid', async () => {
    let release: (() => void) | null = null;
    mermaidMock.render.mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          release = () => resolve({ svg: `<svg id="${id}">stale</svg>` });
        }),
    );
    const { renderMermaidPreview } = await loadModule();
    // 同一个代码块的 applyPreview 都写同一个预览槽
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(release).not.toBeNull());
    // 渲染在途时用户把语言改成 js / 清空内容
    expect(renderMermaidPreview('js', 'graph TD\n  A-->B', apply)).toBeNull();
    release!();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));

    expect(apply.mock.calls[0]![0]).toContain('stale');
    expect(apply.mock.calls[1]![0]).toBeNull();
  });

  it('recovers on the next render after a failed initialization', async () => {
    mermaidMock.initialize.mockImplementationOnce(() => {
      throw new Error('init failed');
    });
    const { renderMermaidPreview, t } = await loadModule();
    const apply = vi.fn();

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toContain(
      t('panels.editor.mermaid.renderError'),
    );

    renderMermaidPreview('mermaid', 'graph TD\n  A-->B', apply);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]![0]).toContain('<svg');
  });
});

// 主题切换时不重挂载编辑器(会丢光标 / 滚动 / 200ms 内未落 store 的输入),而是就地重画已显示的图。
describe('redrawMermaidPreviews', () => {
  function mountBlock(code: string, shown: string) {
    const block = document.createElement('div');
    block.className = 'milkdown-code-block';
    const host = document.createElement('div');
    host.className = 'codemirror-host';
    const view = new EditorView({ doc: code, parent: host });
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.innerHTML = shown;
    block.append(host, preview);
    document.body.appendChild(block);
    return { preview, view };
  }

  it('re-renders every shown diagram from its code block source, sanitized', async () => {
    mermaidMock.render.mockImplementation(async (id: string, code: string) => ({
      svg: `<svg id="${id}"><text>${code}</text><script>alert(1)</script></svg>`,
    }));
    const { redrawMermaidPreviews } = await loadModule();
    const a = mountBlock('graph TD\n  A-->B', '<div class="continuo-mermaid"><svg>old-a</svg></div>');
    const b = mountBlock('graph LR\n  X-->Y', '<div class="continuo-mermaid"><svg>old-b</svg></div>');
    // 没有图(普通代码块 / 语法错误提示)的块不动
    const plain = mountBlock('const a = 1;', '');
    const failed = mountBlock('bad', '<pre class="continuo-mermaid-error">err</pre>');

    redrawMermaidPreviews(document.body);
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(b.preview.textContent).toContain('graph LR'));

    expect(a.preview.textContent).toContain('graph TD');
    expect(a.preview.textContent).not.toContain('old-a');
    expect(a.preview.querySelector('.continuo-mermaid > svg')).not.toBeNull();
    expect(a.preview.innerHTML).not.toContain('<script');
    expect(plain.preview.innerHTML).toBe('');
    expect(failed.preview.textContent).toBe('err');
    for (const x of [a, b, plain, failed]) x.view.destroy();
  });

  // dockview 把后台 dock tab 的内容从文档里摘下来(React 树还在)。用户在设置面板切主题时
  // 编辑器正是这个状态,回来时图必须已经是新主题。
  it('also redraws while the editor subtree is detached from the document', async () => {
    const { redrawMermaidPreviews } = await loadModule();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const block = mountBlock('graph TD\n  A-->B', '<div class="continuo-mermaid"><svg>old</svg></div>');
    root.appendChild(block.preview.parentElement!);
    root.remove();

    redrawMermaidPreviews(root);
    await vi.waitFor(() => expect(block.preview.textContent).toContain('graph TD'));
    block.view.destroy();
  });

  it('keeps the current diagram when the re-render fails or the block is gone', async () => {
    const { redrawMermaidPreviews } = await loadModule();
    const kept = mountBlock('graph TD\n  A-->B', '<div class="continuo-mermaid"><svg>old</svg></div>');
    const gone = mountBlock('graph TD\n  C-->D', '<div class="continuo-mermaid"><svg>old</svg></div>');
    mermaidMock.render.mockRejectedValueOnce(new Error('boom'));

    redrawMermaidPreviews(document.body);
    const detached = gone.preview.firstElementChild!;
    gone.preview.innerHTML = '';
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(kept.preview.textContent).toBe('old');
    expect(detached.textContent).toBe('old');
    kept.view.destroy();
    gone.view.destroy();
  });
});

// 每次按键都完整渲染一遍的话,大图(几十个节点,单次渲染几百毫秒)里打字会逐键卡顿。
// 能认出「是同一个代码块在连续修改」时,只在停手后渲染最后一版。
describe('renderMermaidPreview while typing', () => {
  function mountEditor(codes: string[]) {
    const root = document.createElement('div');
    const views = codes.map((code) => {
      const block = document.createElement('div');
      block.className = 'milkdown-code-block';
      const view = new EditorView({ doc: code, parent: block });
      root.appendChild(block);
      return view;
    });
    document.body.appendChild(root);
    return { root, views };
  }

  function edit(view: EditorView, text: string): string {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
    return view.state.doc.toString();
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('renders only the last version of a block that is being edited', async () => {
    const { renderMermaidPreview, registerMermaidRoot } = await loadModule();
    const { root, views } = mountEditor(['graph TD\n  A-->B', 'graph LR\n  X-->Y']);
    const unregister = registerMermaidRoot(root);
    const apply = vi.fn();

    for (const ch of ['1', '2', '3']) {
      expect(
        renderMermaidPreview('mermaid', edit(views[0]!, ch), apply),
      ).toBeUndefined();
    }
    await pause(50);
    expect(mermaidMock.render).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(mermaidMock.render.mock.calls[0]![1]).toBe('graph TD\n  A-->B123');
    unregister();
    for (const v of views) v.destroy();
  });

  it('renders immediately when the block cannot be identified (first mount, duplicate content)', async () => {
    const { renderMermaidPreview, registerMermaidRoot } = await loadModule();
    const same = 'graph TD\n  A-->B';
    const { root, views } = mountEditor([same, same]);
    const unregister = registerMermaidRoot(root);
    const apply = vi.fn();

    // 两个内容相同的块:认不出是谁 → 两次请求都渲染,谁也不顶掉谁
    renderMermaidPreview('mermaid', same, apply);
    renderMermaidPreview('mermaid', same, apply);
    // 不在任何已登记编辑器里的内容(挂载期 DOM 还没接上)
    renderMermaidPreview('mermaid', 'graph TD\n  not-mounted', apply);
    await pause(50);

    expect(mermaidMock.render).toHaveBeenCalledTimes(3);
    unregister();
    for (const v of views) v.destroy();
  });

  it('drops the pending render when the block was emptied or stopped being mermaid', async () => {
    const { renderMermaidPreview, registerMermaidRoot } = await loadModule();
    const { root, views } = mountEditor(['graph TD\n  A-->B', 'graph LR\n  X-->Y']);
    const unregister = registerMermaidRoot(root);
    const apply = vi.fn();

    // 块 0:改了一下,随即清空
    renderMermaidPreview('mermaid', edit(views[0]!, '1'), apply);
    views[0]!.dispatch({ changes: { from: 0, to: views[0]!.state.doc.length } });
    expect(renderMermaidPreview('mermaid', '', apply)).toBeNull();
    // 块 1:改了一下,随即把语言换成 js(内容不变)
    const code = edit(views[1]!, '1');
    renderMermaidPreview('mermaid', code, apply);
    expect(renderMermaidPreview('js', code, apply)).toBeNull();

    await pause(500);
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    unregister();
    for (const v of views) v.destroy();
  });
});
