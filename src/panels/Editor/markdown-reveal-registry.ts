// 「打开文件并定位到行 / 列(选中匹配)」在 Markdown 编辑 / 预览(Milkdown)里的兑现(VSCode:打开搜索结果总定位并选中匹配)。
// BDD: src/__tests__/search-open-markdown/
//
// 同 editor-focus-registry:MilkdownEditor 在视图就绪时按「编辑器组 + tab」登记定位句柄;editor.openFile 在打开成功后请求定位。
// 视图还没挂上(读盘 / 引擎 chunk 加载 / Crepe 异步创建)时记为待兑现,登记时兑现;超时作废。兑现放到下一帧:视图就绪时
// 同一帧排定的滚动位置恢复(视图状态缓存 / 切模式锚点)先跑,定位在其后,不被它覆盖。
//
// 本模块在 main-app 启动路径上(co-app 引用),不得静态 import Milkdown。

import { useEditorStore } from '@/stores/editor.store';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';

export interface MarkdownRevealTarget {
  /** 源码行(1 起)。 */
  readonly line: number;
  /** 源码列(1 起,UTF-16)。 */
  readonly column?: number;
  /** 选中长度(UTF-16);缺省只放光标。 */
  readonly length?: number;
}

/** 定位结果:applied = 已定位;out-of-range = 行号超出;not-mounted = 期限内视图未就绪 / 被新请求取代 / 已拆除。 */
export type MarkdownRevealOutcome = 'applied' | 'out-of-range' | 'not-mounted';

/** 视图的定位句柄:null = 视图已拆除。 */
type Revealer = (target: MarkdownRevealTarget) => 'applied' | 'out-of-range' | null;

/** 等视图就绪的上限(同 editor-focus-registry 的待兑现期限)。 */
export const MARKDOWN_REVEAL_TIMEOUT_MS = 5000;

/** 视图当前所在的源码行(编辑:光标行;只读预览:顶部可见行);未就绪 / 已拆除 → null。 */
type Locator = () => number | null;

const revealers = new Map<string, Revealer>();
const locators = new Map<string, Locator>();

interface Request {
  readonly key: string;
  readonly target: MarkdownRevealTarget;
  readonly settle: (outcome: MarkdownRevealOutcome) => void;
  /** 已排定在下一帧兑现(视图已登记)。 */
  scheduled: boolean;
}
/** 最新的请求(待兑现或已排定);新请求取代它。 */
let latest: Request | null = null;

function keyOf(tabId: string, groupId: string): string {
  return `${groupId}\u0000${tabId}`;
}

function scheduleReveal(req: Request): void {
  req.scheduled = true;
  requestAnimationFrame(() => {
    if (latest !== req) return req.settle('not-mounted'); // 已被新请求取代
    const reveal = revealers.get(req.key);
    if (reveal === undefined) {
      // 期间卸载了(如切模式重挂):等同 tab 的新视图登记
      req.scheduled = false;
      return;
    }
    req.settle(reveal(req.target) ?? 'not-mounted');
  });
}

/**
 * 视图就绪时登记(同组同 tab 后登记者取代先登记者);返回注销函数。locate = 视图当前所在的源码行(后退 / 前进记「跳转前位置」用,
 * 见 navigation-history recordNavigationOrigin)。
 */
export function registerMarkdownReveal(
  tabId: string,
  reveal: Revealer,
  groupId: string = PRIMARY_EDITOR_GROUP_ID,
  locate?: Locator,
): () => void {
  const key = keyOf(tabId, groupId);
  revealers.set(key, reveal);
  if (locate) locators.set(key, locate);
  else locators.delete(key);
  if (latest !== null && latest.key === key && !latest.scheduled) scheduleReveal(latest);
  return () => {
    if (revealers.get(key) === reveal) {
      revealers.delete(key);
      locators.delete(key);
    }
  };
}

/** 该 tab 在组 groupId 里的 Markdown 视图当前所在的源码行;未登记 / 未就绪 → null。 */
export function markdownViewLine(tabId: string, groupId: string): number | null {
  return locators.get(keyOf(tabId, groupId))?.() ?? null;
}

/**
 * 请求该 tab 在组 groupId(缺省活动组)里的 Markdown 视图定位到 target:已就绪 → 下一帧定位;否则就绪时定位;
 * 期限(MARKDOWN_REVEAL_TIMEOUT_MS)内未就绪 → not-mounted。新请求取代未兑现的旧请求(旧请求得到 not-mounted)。
 */
export function revealInMarkdown(
  tabId: string,
  target: MarkdownRevealTarget,
  groupId: string = useEditorStore.getState().activeGroupId,
): Promise<MarkdownRevealOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => req.settle('not-mounted'), MARKDOWN_REVEAL_TIMEOUT_MS);
    const req: Request = {
      key: keyOf(tabId, groupId),
      target,
      scheduled: false,
      settle: (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (latest === req) latest = null;
        resolve(outcome);
      },
    };
    const previous = latest;
    latest = req;
    previous?.settle('not-mounted');
    if (revealers.has(req.key)) scheduleReveal(req);
  });
}

/** 测试用:清空。 */
export function __resetMarkdownRevealForTest(): void {
  latest?.settle('not-mounted');
  latest = null;
  revealers.clear();
  locators.clear();
}
