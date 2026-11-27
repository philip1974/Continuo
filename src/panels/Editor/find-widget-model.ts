// 编辑器查找控件的纯逻辑(对齐 VSCode findWidget):查找历史(↑ / ↓)与匹配计数文案。与编辑器引擎无关 ——
// CodeMirror 查找面板(codemirror-find.ts)使用;Markdown 编辑模式等其它查找 UI 可直接复用同一历史与文案。
// BDD: src/__tests__/editor-find-widget/

import { t, translateCount } from '@/i18n';

/** 计数上限(同终端查找 1000):超出只显示「1000+」,扫描到此即停,大文档不整篇遍历。 */
export const FIND_MATCH_LIMIT = 1000;

/** 历史条数上限(VSCode 查找历史同为 50)。 */
export const FIND_HISTORY_LIMIT = 50;

/**
 * 查找词历史(VSCode HistoryNavigator 语义):去重(再次加入移到最新)、最多 50 条;↑ 先把当前输入记入再往前翻,
 * 到最旧停住;↓ 往回,越过最新回到空输入。
 */
export class FindHistory {
  private items: string[] = [];
  /** 导航位置;items.length = 未在导航中。 */
  private cursor = 0;

  constructor(private readonly limit = FIND_HISTORY_LIMIT) {}

  entries(): readonly string[] {
    return this.items;
  }

  add(term: string): void {
    if (!term) return;
    const i = this.items.indexOf(term);
    if (i >= 0) this.items.splice(i, 1);
    this.items.push(term);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    this.cursor = this.items.length;
  }

  /** 输入框被用户改动 / 重新打开:下次 ↑ 从最新开始。 */
  resetCursor(): void {
    this.cursor = this.items.length;
  }

  clear(): void {
    this.items = [];
    this.cursor = 0;
  }

  /** ↑:更早的一条;没有更早的返回 undefined(输入框不变)。 */
  previous(current: string): string | undefined {
    if (this.cursor >= this.items.length) {
      this.add(current);
      const at = current ? this.items.indexOf(current) : -1;
      this.cursor = at >= 0 ? at : this.items.length;
    }
    if (this.cursor <= 0) return undefined;
    this.cursor -= 1;
    return this.items[this.cursor];
  }

  /** ↓:更新的一条;越过最新返回 ''(清空);已在末尾返回 undefined。 */
  next(): string | undefined {
    if (this.cursor >= this.items.length) return undefined;
    this.cursor += 1;
    return this.cursor < this.items.length ? this.items[this.cursor] : '';
  }
}

/** 本窗口所有编辑器共享的查找历史(renderer 每窗一份模块实例,不落盘;VSCode 同为工作台内共享)。 */
export const editorFindHistory = new FindHistory();

export interface FindCountState {
  /** 查找词为空:不显示计数也不标红。 */
  readonly empty: boolean;
  /** 已数到的匹配数(封顶 FIND_MATCH_LIMIT)。 */
  readonly total: number;
  /** 当前匹配的序号(1 起);0 = 当前选区不在已数到的匹配上。 */
  readonly current: number;
  /** 达到上限停止计数。 */
  readonly capped: boolean;
  /** 正则模式下查找词不是合法正则(VSCode 查找框弹出正则错误信息)。 */
  readonly invalid?: boolean;
  /** 大文档计数仍在进行(分片扫描):total 只是已扫到的部分。 */
  readonly pending?: boolean;
}

/** 计数进行中且还没数到匹配时的文案(不显示「无结果」、不标红)。 */
export const FIND_COUNT_PENDING = '…';

/**
 * 计数文案:「3 / 154」;无当前匹配只显示总数「154 个匹配」;封顶「1000+」;无匹配「无结果」;非法正则「正则表达式无效」;空查询空串。
 * 计数进行中:已数到的部分加「+」(「3 / 12+」「12+ 个匹配」),一个都没数到显示「…」。
 */
export function formatFindCount({ empty, total, current, capped, invalid, pending }: FindCountState): string {
  if (empty) return '';
  if (invalid) return t('editor.find.invalid_regex');
  if (total <= 0) return pending ? FIND_COUNT_PENDING : t('editor.find.no_results');
  const totalText = capped ? `${FIND_MATCH_LIMIT}+` : pending ? `${total}+` : String(total);
  if (current > 0) return t('editor.find.match_count', { n: current, total: totalText });
  return capped || pending
    ? t('editor.find.match_total_other', { count: totalText })
    : translateCount('editor.find.match_total', total);
}
