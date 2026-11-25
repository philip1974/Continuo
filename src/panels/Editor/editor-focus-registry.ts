// 「打开文件后把 DOM 焦点交给编辑器」(VSCode:Quick Open 回车、Explorer 新建文件后可直接打字)。
// BDD: src/__tests__/editor-focus-on-open/
//
// 两个引擎(CodeEditor / MilkdownEditor)在视图就绪时按 tab 登记聚焦句柄;打开入口在打开成功后 requestEditorFocus。
// 兑现放到下一帧:Quick Open 关闭时 Modal 把焦点还给打开前的元素(旧编辑器)、旧编辑器随 key 变化卸载,
// 都在同一次提交里,须晚于它们。视图还没挂上(读盘 / 引擎 chunk 加载 / Milkdown 异步创建)时记为待兑现,
// 该 tab 的视图登记时(同样下一帧)聚焦一次;超时作废,免得很久之后的重挂载抢焦点。

import { useEditorStore } from '@/stores/editor.store';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';

const PENDING_TTL_MS = 5000;

// 按「编辑器组 + tab」登记:同一文件在两个组各有一个视图(BDD: src/__tests__/editor-groups/)。
const focusers = new Map<string, () => void>();
let pending: { readonly key: string; readonly until: number } | null = null;

function keyOf(tabId: string, groupId: string): string {
  return `${groupId}\u0000${tabId}`;
}

function focusNextFrame(key: string, focus: () => void): void {
  requestAnimationFrame(() => {
    // 期间已卸载 / 被同 tab 的新视图取代 → 不聚焦旧的
    if (focusers.get(key) === focus) focus();
  });
}

/** 视图就绪时登记(同组同 tab 后登记者取代先登记者);返回注销函数。 */
export function registerEditorFocus(
  tabId: string,
  focus: () => void,
  groupId: string = PRIMARY_EDITOR_GROUP_ID,
): () => void {
  const key = keyOf(tabId, groupId);
  focusers.set(key, focus);
  if (pending !== null && pending.key === key) {
    const live = performance.now() <= pending.until;
    pending = null;
    if (live) focusNextFrame(key, focus);
  }
  return () => {
    if (focusers.get(key) === focus) focusers.delete(key);
  };
}

/**
 * 请求聚焦该 tab 在组 groupId(缺省活动组)里的编辑器:已就绪 → 下一帧聚焦;否则就绪时聚焦。新请求取代旧请求。
 */
export function requestEditorFocus(tabId: string, groupId: string = useEditorStore.getState().activeGroupId): void {
  const key = keyOf(tabId, groupId);
  pending = { key, until: performance.now() + PENDING_TTL_MS };
  requestAnimationFrame(() => {
    if (pending?.key !== key) return;
    const focus = focusers.get(key);
    if (focus === undefined) return;
    pending = null;
    focus();
  });
}

/** 打开文件成功后调用:聚焦活动组的活动 tab 的编辑器。 */
export function focusActiveEditor(): void {
  const { activeTabId, activeGroupId } = useEditorStore.getState();
  if (activeTabId !== null) requestEditorFocus(activeTabId, activeGroupId);
}
