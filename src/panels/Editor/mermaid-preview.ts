// Markdown ```mermaid 代码块(流程图 / 时序图等)的图预览,接在 Crepe CodeMirror 特性的
// renderPreview 上(Crepe 的 LaTeX 预览走同一扩展点)。
// 懒加载单例与加固配置移植自 AgentFramwork packages/markdown 的 mermaid-singleton.ts:
//   securityLevel 'strict' + htmlLabels false → 输出静态 SVG(无脚本 / 点击回调 / 内嵌 HTML)。
// 与参考实现的区别:不套 iframe —— Crepe 预览面板落 DOM 前统一过 DOMPurify(默认配置),
// 本文件就地重画(redrawMermaidPreviews)时用同一个 sanitizer、同一份默认配置。

import { EditorView } from '@codemirror/view';
import DOMPurify from 'dompurify';
import { t } from '@/i18n';

type ApplyPreview = (value: null | string | HTMLElement) => void;

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;
/** 上次 initialize 用的主题配置(序列化);变了才重新 initialize. */
let initializedTheme: string | null = null;
let renderSeq = 0;
// 渲染串行:同一代码块连续修改时预览按修改顺序落地,且 initialize(theme) 不会与在途渲染交错。
let renderQueue: Promise<void> = Promise.resolve();
let pendingRenders = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise === null) {
    const attempt = import('mermaid').then(
      (mod) => mod.default as unknown as MermaidApi,
    );
    // 加载失败(chunk 读不到等)不缓存 rejected promise,下次渲染重试
    attempt.catch(() => {
      if (mermaidPromise === attempt) mermaidPromise = null;
    });
    mermaidPromise = attempt;
  }
  return mermaidPromise;
}

// mermaid `base` 主题变量 ← 应用语义 token(theme.css 的 --md-*,light / dark 各有值)。
// 图落在代码块里,底色取代码块底色(Crepe surface = --md-surface-container)。
const THEME_TOKENS: Readonly<Record<string, string>> = {
  background: '--md-surface-container',
  primaryColor: '--md-surface-container-high',
  primaryTextColor: '--md-on-surface',
  primaryBorderColor: '--md-outline',
  lineColor: '--md-on-surface-variant',
  secondaryColor: '--md-surface-container-highest',
  tertiaryColor: '--md-surface-container-low',
  // 连线标签的衬底与图底色一致(否则 base 主题在暗色下派生出近黑的色块)
  edgeLabelBackground: '--md-surface-container',
};

// 与 ThemeProvider.applyThemeClass 同一事实来源:<html class="dark"> + 其上生效的 --md-* 值。
function currentThemeConfig(): Record<string, unknown> {
  const root = document.documentElement;
  const darkMode = root.classList.contains('dark');
  const style = getComputedStyle(root);
  const themeVariables: Record<string, unknown> = { darkMode };
  for (const [variable, token] of Object.entries(THEME_TOKENS)) {
    const value = style.getPropertyValue(token).trim();
    // token 读不到(样式表未加载等)→ 退回 mermaid 内置配色,不拿残缺的变量去拼
    if (value === '') return { theme: darkMode ? 'dark' : 'default' };
    themeVariables[variable] = value;
  }
  return { theme: 'base', themeVariables };
}

async function renderSvg(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const themeConfig = currentThemeConfig();
  const themeKey = JSON.stringify(themeConfig);
  if (initializedTheme !== themeKey) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // mermaid 11 的 flowchart-v2 读这个全局开关决定用 SVG text 还是 foreignObject;
      // 只设 flowchart.htmlLabels 仍会产出 foreignObject(被 sanitizer 剥掉后节点没字)。
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // 语法错误时不要往 document.body 插 mermaid 自带的「炸弹」错误图,错误由调用方展示
      suppressErrorRendering: true,
      // 图表源码里的 %%{init}%% 指令不许改写这些键。传 secure 会整体替换默认列表,故默认项照抄;
      // 追加 htmlLabels(切回 foreignObject 标签会被 sanitizer 剥掉 → 节点没字)与
      // themeCSS(可带 url(https://…),打开不受信文档时发外部请求)。
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'htmlLabels',
        'themeCSS',
      ],
      ...themeConfig,
    });
    initializedTheme = themeKey;
  }
  renderSeq += 1;
  const { svg } = await mermaid.render(`continuo-mermaid-${renderSeq}`, code);
  return svg;
}

function enqueueRender(
  code: string,
  onSvg: (svg: string) => void,
  onError: (err: unknown) => void,
): void {
  pendingRenders += 1;
  renderQueue = renderQueue
    .then(() => renderSvg(code))
    .then(onSvg, onError)
    .finally(() => {
      pendingRenders -= 1;
    });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorHtml(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `<pre class="continuo-mermaid-error">${escapeHtml(
    `${t('panels.editor.mermaid.renderError')}\n${detail}`,
  )}</pre>`;
}

// ── 连续输入时只渲染最后一版 ─────────────────────────────────────────
// Crepe 每次内容变化都调一次 renderPreview,且不告诉我们是哪个代码块。逐键完整渲染在大图里
// (几十个节点,单次几百毫秒,占主线程)会让打字逐键卡顿。这里按内容反查代码块:已登记的编辑器
// 里**恰好一个**代码块的 CodeMirror 文档等于这次的内容 → 认定是它在被修改,停手
// TYPING_SETTLE_MS 后只渲染最后一版。认不出(首次挂载 DOM 还没接上、两个块内容相同)→ 立即渲染。
const TYPING_SETTLE_MS = 250;
const roots = new Set<ParentNode>();
interface PendingEdit {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly code: string;
}
const pendingEdits = new Map<Element, PendingEdit>();

/** MilkdownEditor 挂载时登记自己的容器,返回注销函数. */
export function registerMermaidRoot(root: ParentNode): () => void {
  roots.add(root);
  return () => {
    roots.delete(root);
  };
}

function codeBlockDoc(block: Element): string | null {
  const editorDom = block.querySelector<HTMLElement>('.cm-editor');
  const view = editorDom ? EditorView.findFromDOM(editorDom) : null;
  return view ? view.state.doc.toString() : null;
}

function findCodeBlock(content: string): Element | null {
  let found: Element | null = null;
  for (const root of roots) {
    for (const block of root.querySelectorAll('.milkdown-code-block')) {
      if (codeBlockDoc(block) !== content) continue;
      if (found) return null;
      found = block;
    }
  }
  return found;
}

function cancelPendingEdit(block: Element): void {
  const pending = pendingEdits.get(block);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingEdits.delete(block);
}

/**
 * Crepe `CodeBlockConfig.renderPreview` 实现。返回值约定(见 @milkdown/components code-block):
 *   null → 该代码块没有预览;undefined → 异步预览,稍后经 applyPreview 落地。
 */
export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: ApplyPreview,
): void | null {
  if (language.toLowerCase() !== 'mermaid' || content.trim() === '') {
    // 该块停手后待渲染的那一版作废(没有待渲染的块时不反查,普通代码块零开销)
    if (pendingEdits.size > 0) {
      const block = findCodeBlock(content);
      if (block) cancelPendingEdit(block);
    }
    // 该块之前的渲染可能还在途(首次加载 mermaid 可达秒级):排一个清空,免得迟到的旧图
    // 落到已经不是 mermaid / 已清空的代码块上。没有在途渲染时不排。
    if (pendingRenders > 0) renderQueue = renderQueue.then(() => applyPreview(null));
    return null;
  }
  const render = (): void =>
    enqueueRender(
      content,
      (svg) => applyPreview(`<div class="continuo-mermaid">${svg}</div>`),
      (err) => applyPreview(errorHtml(err)),
    );
  const block = findCodeBlock(content);
  // 待渲染的那一版内容与这次相同 → 不是「同一块的下一次修改」(真修改内容必变),
  // 多半是另一个内容相同、DOM 还没接上的块:不顶掉别人,立即渲染。
  if (!block || pendingEdits.get(block)?.code === content) {
    render();
    return undefined;
  }
  cancelPendingEdit(block);
  const timer = setTimeout(() => {
    pendingEdits.delete(block);
    // 停手期间块又变了(被清空等,且没能反查到它来取消)→ 这一版作废
    if (codeBlockDoc(block) === content) render();
  }, TYPING_SETTLE_MS);
  pendingEdits.set(block, { timer, code: content });
  return undefined;
}

/**
 * 按当前主题就地重画 root 下已显示的 mermaid 图(主题切换时调)。不经 Crepe 的 renderPreview ——
 * 它只在代码块内容 / 语言变化时触发 —— 所以这里自己取源码(代码块的 CodeMirror 文档)、
 * 自己过 sanitizer。重画失败或该图已被换掉时保持现状。
 */
export function redrawMermaidPreviews(root: ParentNode): void {
  for (const holder of root.querySelectorAll<HTMLElement>('.continuo-mermaid')) {
    const block = holder.closest('.milkdown-code-block');
    const code = block ? codeBlockDoc(block) : null;
    if (code === null) continue;
    enqueueRender(
      code,
      (svg) => {
        // 判「还在这棵子树里」而不是 isConnected:后台 dock tab 的内容被 dockview 摘出文档,
        // 用户在设置面板切主题时编辑器正是这个状态。
        if (root.contains(holder)) holder.innerHTML = DOMPurify.sanitize(svg);
      },
      () => {},
    );
  }
}
