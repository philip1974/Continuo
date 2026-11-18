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

interface RenderedSvg {
  readonly svg: string;
  /** 本次渲染用的主题配置(序列化),即缓存键的主题部分. */
  readonly themeKey: string;
  /** 传给 mermaid.render 的 id(SVG 内的 id / 样式选择器 / marker 引用都以它为前缀). */
  readonly id: string;
}

const SVG_ID_PREFIX = 'continuo-mermaid-';

async function renderSvg(code: string): Promise<RenderedSvg> {
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
      // fontFamily / altFontFamily 同理:mermaid 对它们只查花括号配对,值原样拼进
      // `:root { --mermaid-font-family: …}` 与外层 div 的 style —— `x; background:url(https://…)`
      // 即成一条独立声明(指令里的 fontFamily 还会被复制进 themeVariables.fontFamily,
      // 绕过 themeVariables 的字符集检查)。secure 在指令的每一层都生效,两处一并挡住。
      // 其余进 CSS 的配置:themeCSS(已锁)、themeVariables.*(mermaid 以 /^[\d "#%(),.;A-Za-z]+$/
      // 过滤,无冒号/斜杠拼不出声明);各图表的 *FontFamily(c4/sequence/journey 等)只经
      // style.setProperty / setAttribute 单属性写入,`;` 无法逃出该属性。
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'htmlLabels',
        'themeCSS',
        'fontFamily',
        'altFontFamily',
      ],
      ...themeConfig,
    });
    initializedTheme = themeKey;
  }
  renderSeq += 1;
  const id = `${SVG_ID_PREFIX}${renderSeq}`;
  const { svg } = await mermaid.render(id, code);
  return { svg, themeKey, id };
}

// ── 渲染结果缓存 ────────────────────────────────────────────────────
// 切 tab / 切 Edit↔Preview / 外部改动重载都会重挂 Milkdown,code-block 挂载时对每个代码块调一次
// renderPreview。源码与主题都没变时直接同步返回上次的结果(Crepe 收到字符串立即作预览,
// 不出 previewLoading 占位),不再进全局串行队列完整重渲(大图单次几百毫秒)。
// 有界 LRU:条目数 + 总量(UTF-16 按 2 字节/字符估)双上限;错误不缓存。
export const MERMAID_PREVIEW_CACHE = {
  maxEntries: 48,
  maxBytes: 8 * 1024 * 1024,
} as const;

interface CachedPreview {
  /** 已包装的 `<div class="continuo-mermaid">…</div>`. */
  readonly html: string;
  readonly id: string;
}
const previewCache = new Map<string, CachedPreview>();
let previewCacheBytes = 0;

function cacheKey(themeKey: string, code: string): string {
  return `${themeKey}\0${code}`;
}

function entryBytes(key: string, entry: CachedPreview): number {
  return (key.length + entry.html.length) * 2;
}

function cacheDelete(key: string): void {
  const entry = previewCache.get(key);
  if (!entry) return;
  previewCache.delete(key);
  previewCacheBytes -= entryBytes(key, entry);
}

function cacheStore(themeKey: string, code: string, entry: CachedPreview): void {
  const key = cacheKey(themeKey, code);
  cacheDelete(key);
  const bytes = entryBytes(key, entry);
  if (bytes > MERMAID_PREVIEW_CACHE.maxBytes) return;
  previewCache.set(key, entry);
  previewCacheBytes += bytes;
  for (const oldest of previewCache.keys()) {
    if (
      previewCache.size <= MERMAID_PREVIEW_CACHE.maxEntries &&
      previewCacheBytes <= MERMAID_PREVIEW_CACHE.maxBytes
    ) {
      break;
    }
    cacheDelete(oldest);
  }
}

// 命中时把 SVG 里的 id 前缀换成新的唯一值:mermaid 输出的 <style> 选择器(#id …)、元素 id、
// marker-end="url(#id_…)" 都以渲染 id 为前缀。同一窗口里两处同时显示同一张图(同文档两个相同的块、
// 分屏开同一文件)若共用 id,url(#…) 解析到文档中第一个同 id 元素 —— 那张图被隐藏 / 摘下时
// 另一张的箭头会丢。替换是对 HTML 字符串的一次线性扫描(几十 KB 级,亚毫秒),远低于重渲。
function withFreshId(entry: CachedPreview): string {
  renderSeq += 1;
  const pattern = new RegExp(`${entry.id}(?!\\d)`, 'g');
  return entry.html.replace(pattern, `${SVG_ID_PREFIX}${renderSeq}`);
}

// 主题键记忆:配色只由 <html> 的 class(dark)/ 内联 style 上的 --md-* 决定。用 MutationObserver
// 记录这两个属性的变化,查缓存时同步 takeRecords() —— 有变化才重新 getComputedStyle,
// 不必每个代码块挂载都强制样式计算。token 读不到(退回内置主题,样式表可能还没加载完)时不记忆。
let themeKeyMemo: string | null = null;
let themeObserver: MutationObserver | null = null;

function lookupThemeKey(): string {
  if (themeObserver === null && typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => {
      themeKeyMemo = null;
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
  if (themeObserver !== null && themeObserver.takeRecords().length > 0) {
    themeKeyMemo = null;
  }
  if (themeKeyMemo !== null) return themeKeyMemo;
  const themeConfig = currentThemeConfig();
  const key = JSON.stringify(themeConfig);
  if (themeObserver !== null && themeConfig.theme === 'base') themeKeyMemo = key;
  return key;
}

function cachedPreview(code: string): string | null {
  const key = cacheKey(lookupThemeKey(), code);
  const entry = previewCache.get(key);
  if (!entry) return null;
  // LRU:命中挪到最新
  previewCache.delete(key);
  previewCache.set(key, entry);
  return withFreshId(entry);
}

function enqueueRender(
  code: string,
  onSvg: (rendered: RenderedSvg) => void,
  onError: (err: unknown) => void,
  isStale: () => boolean = () => false,
): void {
  pendingRenders += 1;
  renderQueue = renderQueue
    .then(() => {
      // 出队时请求方编辑器已卸载 → 不再渲染(结果没人要,还会挡在新文档的渲染前面)
      if (isStale()) return;
      return renderSvg(code).then(onSvg, onError);
    })
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

function codeBlockView(block: Element): EditorView | null {
  const editorDom = block.querySelector<HTMLElement>('.cm-editor');
  return editorDom ? EditorView.findFromDOM(editorDom) : null;
}

function codeBlockDoc(block: Element): string | null {
  const view = codeBlockView(block);
  return view ? view.state.doc.toString() : null;
}

// perf E6:每次按键都要对已登记编辑器的全部代码块反查一遍(防抖之前)。先比长度(Text.length O(1)),
// 不等直接排除,只有长度相同的块才 toString() 逐字比较 —— 不再每键复制所有代码块全文。
// 判定结果与「codeBlockDoc(block) === content」逐字节等价。
function codeBlockMatches(block: Element, content: string): boolean {
  const view = codeBlockView(block);
  if (!view) return false;
  const doc = view.state.doc;
  return doc.length === content.length && doc.toString() === content;
}

function rootHasCodeBlock(root: ParentNode, content: string): boolean {
  for (const block of root.querySelectorAll('.milkdown-code-block')) {
    if (codeBlockMatches(block, content)) return true;
  }
  return false;
}

// 请求方是否已卸载。Crepe 不告诉我们请求来自哪个编辑器(挂载期 DOM 还没接上也反查不到),
// 故按请求时已登记的编辑器快照判断:其中有编辑器已注销,且仍在的那些里都找不到这段源码 → 认定
// 请求来自已卸载的那个。快照里的编辑器都还在时一律照常渲染(不改变既有行为)。
function requestOrphaned(owners: ReadonlySet<ParentNode>, content: string): boolean {
  const alive: ParentNode[] = [];
  for (const root of owners) {
    if (roots.has(root)) alive.push(root);
  }
  if (alive.length === owners.size) return false;
  return !alive.some((root) => rootHasCodeBlock(root, content));
}

function findCodeBlock(content: string): Element | null {
  let found: Element | null = null;
  for (const root of roots) {
    for (const block of root.querySelectorAll('.milkdown-code-block')) {
      if (!codeBlockMatches(block, content)) continue;
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
 *   null → 该代码块没有预览;undefined → 异步预览,稍后经 applyPreview 落地;
 *   字符串 → 同步预览(命中缓存;Crepe 立即设为预览,同样过 DOMPurify)。
 */
export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: ApplyPreview,
): void | null | string {
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
  const hit = cachedPreview(content);
  if (hit !== null) {
    // 与「改成非 mermaid」同理:该块待渲染 / 在途的旧版本不能在这次结果之后再落地
    if (pendingEdits.size > 0) {
      const block = findCodeBlock(content);
      if (block) cancelPendingEdit(block);
    }
    if (pendingRenders > 0) renderQueue = renderQueue.then(() => applyPreview(hit));
    return hit;
  }
  const render = (): void => {
    const owners = new Set(roots);
    enqueueRender(
      content,
      ({ svg, themeKey, id }) => {
        const html = `<div class="continuo-mermaid">${svg}</div>`;
        cacheStore(themeKey, content, { html, id });
        applyPreview(html);
      },
      (err) => applyPreview(errorHtml(err)),
      () => requestOrphaned(owners, content),
    );
  };
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
    if (codeBlockMatches(block, content)) render();
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
  themeKeyMemo = null;
  for (const holder of root.querySelectorAll<HTMLElement>('.continuo-mermaid')) {
    const block = holder.closest('.milkdown-code-block');
    const code = block ? codeBlockDoc(block) : null;
    if (code === null) continue;
    enqueueRender(
      code,
      ({ svg, themeKey, id }) => {
        cacheStore(themeKey, code, {
          html: `<div class="continuo-mermaid">${svg}</div>`,
          id,
        });
        // 判「还在这棵子树里」而不是 isConnected:后台 dock tab 的内容被 dockview 摘出文档,
        // 用户在设置面板切主题时编辑器正是这个状态。
        if (root.contains(holder)) holder.innerHTML = DOMPurify.sanitize(svg);
      },
      () => {},
    );
  }
}
