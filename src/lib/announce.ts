// 全局读屏播报(VSCode aria.alert / aria.status:常驻播报节点;节点队列参考 react-aria LiveAnnouncer)。
// 只需读屏念一句、不随某个元素出现的播报(toast 创建 / 合并、Debug 停下 / 继续运行)都走这里,不各自维护 live region:
// 面板里的 live region 在 dockview 隐藏面板时不在文档,单个 React state 在同 tick 多次播报时只剩最后一条。
// 见 src/__tests__/live-announcer。

import { getTopModalContent } from '@/design';
import { SR_ONLY_STYLE } from './sr-only';

export type AnnouncePoliteness = 'polite' | 'assertive';

export interface AnnounceOptions {
  /** 默认 polite;错误等需打断的用 assertive。 */
  readonly politeness?: AnnouncePoliteness;
  /** 写进哪个文档(主窗 / popout 子窗),默认主窗。 */
  readonly doc?: Document;
}

/** 新建的区域等这么久再插入首条(live region 须先于内容存在,读屏才会播;Safari 尤甚)。 */
export const ANNOUNCE_PRIME_MS = 100;
/** 每条播报节点保留这么久后移除(只读新增,移除不播)。 */
export const ANNOUNCE_CLEAR_MS = 7000;
/** 每个区域最多保留的最近播报节点数。 */
export const ANNOUNCE_MAX_NODES = 5;
/** 插入后多久检查节点是否随宿主模态一起离开了文档(需改投)。 */
export const ANNOUNCE_REHOME_CHECK_MS = 50;

interface AnnouncerPair {
  readonly root: HTMLElement;
  readonly regions: Record<AnnouncePoliteness, HTMLElement>;
  /** 区域刚建好、尚在等待期间的播报(等待结束后按序插入)。 */
  pending: Array<{ text: string; politeness: AnnouncePoliteness }> | null;
  /** 正在改投(避免改投后的节点再次触发改投检查)。 */
  rehomed?: boolean;
}

// 按宿主节点(文档 body 或顶层模态内容)各一对。
const pairs = new WeakMap<HTMLElement, AnnouncerPair>();

function createPair(host: HTMLElement, primed: boolean): AnnouncerPair {
  const doc = host.ownerDocument;
  const root = doc.createElement('div');
  root.setAttribute('data-live-announcer', '');
  // SR_ONLY_STYLE 是 React 内联样式(数值即 px),写进原生 style 时补单位。
  for (const [key, value] of Object.entries(SR_ONLY_STYLE)) {
    (root.style as unknown as Record<string, string>)[key] = typeof value === 'number' ? `${String(value)}px` : String(value);
  }
  const region = (politeness: AnnouncePoliteness): HTMLElement => {
    const el = doc.createElement('div');
    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'false');
    el.setAttribute('aria-relevant', 'additions');
    root.appendChild(el);
    return el;
  };
  const pair: AnnouncerPair = {
    root,
    regions: { polite: region('polite'), assertive: region('assertive') },
    pending: primed ? null : [],
  };
  host.appendChild(root);
  pairs.set(host, pair);
  if (!primed) {
    setTimeout(() => {
      const queued = pair.pending ?? [];
      pair.pending = null;
      for (const item of queued) {
        // 宿主(顶层模态)在等待期间已卸载(如命令面板执行命令时先关面板、命令随即同步 notify):改投当前宿主。
        if (pair.root.isConnected) insert(pair, item.text, item.politeness);
        else rehome(doc, item.text, item.politeness);
      }
    }, ANNOUNCE_PRIME_MS);
  }
  return pair;
}

function pairFor(host: HTMLElement, primed: boolean): AnnouncerPair {
  const existing = pairs.get(host);
  if (existing !== undefined && existing.root.isConnected && existing.root.parentElement === host) return existing;
  return createPair(host, primed);
}

function insert(pair: AnnouncerPair, text: string, politeness: AnnouncePoliteness): void {
  const region = pair.regions[politeness];
  const node = region.ownerDocument.createElement('div');
  node.textContent = text;
  region.appendChild(node);
  while (region.childElementCount > ANNOUNCE_MAX_NODES) region.firstElementChild?.remove();
  // 宿主模态紧接着卸载(同一事件里先关模态再播报:关闭要等事件处理结束才提交)时节点随之离开文档、读屏来不及念 →
  // 短暂延后检查,已脱离文档则改投当前宿主(只改投一次)。
  if (!pair.rehomed) {
    const doc = region.ownerDocument;
    setTimeout(() => {
      if (!node.isConnected && !pair.root.isConnected) rehome(doc, text, politeness);
    }, ANNOUNCE_REHOME_CHECK_MS);
  }
  setTimeout(() => node.remove(), ANNOUNCE_CLEAR_MS);
}

function rehome(doc: Document, text: string, politeness: AnnouncePoliteness): void {
  const host = getTopModalContent(doc) ?? doc.body;
  if (host === null) return;
  const pair = pairFor(host, false);
  pair.rehomed = true;
  if (pair.pending !== null) pair.pending.push({ text, politeness });
  else insert(pair, text, politeness);
  pair.rehomed = false;
}

/** 预先建好该文档根部的一对播报区域(幂等),使之后的播报立即插入。 */
export function prepareAnnouncer(doc: Document): void {
  if (doc.body !== null) pairFor(doc.body, true);
}

/**
 * 读屏播报一句。该文档有打开的 design Modal 时写进顶层模态里的区域(aria-modal 屏蔽对话框外节点),否则写进根部的。
 * 每次播报是一个新节点:同 tick 多条都保留,相同文本也会再读。
 */
export function announce(text: string, options: AnnounceOptions = {}): void {
  const doc = options.doc ?? globalThis.document;
  const politeness = options.politeness ?? 'polite';
  const host = getTopModalContent(doc) ?? doc.body;
  if (host === null || text === '') return;
  const pair = pairFor(host, false);
  if (pair.pending !== null) pair.pending.push({ text, politeness });
  else insert(pair, text, politeness);
}
