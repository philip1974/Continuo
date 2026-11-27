// Markdown 公式的 KaTeX 渲染(编辑 / 预览模式;对照 VSCode markdown-math 的 @vscode/markdown-it-katex)。
// BDD: src/__tests__/markdown-math/
//
//  - 懒加载:katex 单独成 chunk,第一次遇到公式才加载;MilkdownEditor chunk 里的 katex 导入仍由构建插件换成空壳
//    (scripts/vite-milkdown-katex-stub.ts),Crepe 自带的同步渲染入口都被本项目覆盖。样式表已随 Crepe 主题
//    (theme/common/latex.css @import katex.min.css)在 MilkdownEditor 样式里,字体是打包进来的本地文件(font-src 'self'),
//    浏览器只在公式用到某字形时才下载对应字体。
//  - 安全:trust: false(`\href` / `\url` / `\includegraphics` / `\htmlClass` 等命令不生效),throwOnError: false
//    (错误公式显示为错误色的原文,悬停看错误信息);错误色取语义 token --md-error(浅 / 深主题各有值)。公式本身用
//    currentColor,随正文颜色。
//  - 大量公式:同一公式的渲染结果缓存;单帧同步渲染有时间预算,超出的排队分帧补渲(先显示原文)。

interface KatexApi {
  renderToString(tex: string, options: Record<string, unknown>): string;
}

/** KaTeX 选项(VSCode 用 KaTeX 默认:trust 关;本项目另显式关 throwOnError,错误不抛、就地显示)。 */
export const KATEX_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({
  throwOnError: false,
  trust: false,
  // 公式里的中文等 Unicode 文字:不往控制台刷 strict 警告(渲染结果不变)
  strict: 'ignore',
  errorColor: 'var(--md-error)',
  output: 'htmlAndMathml',
});

let katexApi: KatexApi | null = null;
let katexPromise: Promise<KatexApi> | null = null;

/** 加载 katex;失败不缓存,下次再试。 */
export function loadKatex(): Promise<KatexApi> {
  if (katexApi) return Promise.resolve(katexApi);
  if (katexPromise === null) {
    const attempt = import('katex').then((mod) => {
      const api = ((mod as { default?: KatexApi }).default ?? mod) as KatexApi;
      katexApi = api;
      return api;
    });
    attempt.catch(() => {
      if (katexPromise === attempt) katexPromise = null;
    });
    katexPromise = attempt;
  }
  return katexPromise;
}

// 渲染缓存(键 = 模式 + 源码);超过上限整体清空(简单、够用)
const CACHE_LIMIT = 4000;
const cache = new Map<string, string>();

/** katex 已加载时渲染成 HTML(缓存);未加载 → null。 */
export function renderMathHtml(tex: string, displayMode: boolean): string | null {
  const key = (displayMode ? 'D' : 'I') + tex;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!katexApi) return null;
  let html: string;
  try {
    html = katexApi.renderToString(tex, { ...KATEX_OPTIONS, displayMode });
  } catch {
    // throwOnError: false 下只剩选项 / 内部错误:按原文显示
    html = `<span class="katex-error">${escapeHtml(tex)}</span>`;
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, html);
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 单帧同步渲染预算:超出后的公式排队,下一帧继续
const FRAME_BUDGET_MS = 12;
let frameStart = 0;
let frameSpent = 0;
interface Pending {
  readonly el: HTMLElement;
  readonly tex: string;
  readonly display: boolean;
}
let queue: Pending[] = [];
let flushScheduled = false;

function now(): number {
  return performance.now();
}

function withinBudget(): boolean {
  const t = now();
  if (t - frameStart > 50) {
    frameStart = t;
    frameSpent = 0;
  }
  return frameSpent < FRAME_BUDGET_MS;
}

function paint(el: HTMLElement, html: string): void {
  el.innerHTML = html;
  el.classList.remove('continuo-math-pending');
}

/**
 * 把公式渲染进 `el`:已缓存或预算内 → 立即;否则先显示原文(.continuo-math-pending),katex 加载后 / 下一帧补渲。
 */
export function renderMathInto(el: HTMLElement, tex: string, displayMode: boolean): void {
  const cached = cache.get((displayMode ? 'D' : 'I') + tex);
  if (cached !== undefined) {
    paint(el, cached);
    return;
  }
  if (katexApi && withinBudget()) {
    const t0 = now();
    const html = renderMathHtml(tex, displayMode)!;
    frameSpent += now() - t0;
    paint(el, html);
    return;
  }
  el.textContent = tex;
  el.classList.add('continuo-math-pending');
  queue.push({ el, tex, display: displayMode });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  void loadKatex().then(
    () => setTimeout(flush, 0),
    () => {
      // 加载失败:保留原文显示,丢弃队列(下次渲染再试加载)
      flushScheduled = false;
      queue = [];
    },
  );
}

function flush(): void {
  flushScheduled = false;
  const start = now();
  frameStart = start;
  frameSpent = 0;
  while (queue.length > 0) {
    const item = queue.shift()!;
    // 已被替换 / 移除的公式不再渲染(同一元素的内容已不是这条源码 → 有更新的渲染请求)
    if (!item.el.isConnected || item.el.textContent !== item.tex) continue;
    paint(item.el, renderMathHtml(item.tex, item.display)!);
    if (now() - start > FRAME_BUDGET_MS && queue.length > 0) {
      flushScheduled = true;
      setTimeout(flush, 16);
      return;
    }
  }
}

type ApplyPreview = (value: null | string | HTMLElement) => void;

/**
 * 代码块预览(Crepe CodeMirror 的 renderPreview 约定):`$$` 公式块与 ```latex / ```math 围栏。
 * 已加载 → 直接返回 HTML;未加载 → 返回 undefined(显示「加载中」),加载后 applyPreview。空内容 → null(无预览)。
 */
export function renderMathPreview(content: string, applyPreview: ApplyPreview): string | null | undefined {
  if (content.trim() === '') return null;
  const html = renderMathHtml(content, true);
  if (html !== null) return wrapBlock(html);
  void loadKatex().then(
    () => applyPreview(wrapBlock(renderMathHtml(content, true)!)),
    () => applyPreview(null),
  );
  return undefined;
}

function wrapBlock(html: string): string {
  return `<div class="continuo-math-block">${html}</div>`;
}

/** 测试用:清空加载状态与缓存。 */
export function resetKatexForTest(): void {
  katexApi = null;
  katexPromise = null;
  cache.clear();
  queue = [];
  flushScheduled = false;
}
