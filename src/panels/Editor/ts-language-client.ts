// TS / JS 语言服务的 renderer 客户端(VSCode typescript-language-features 的 BufferSyncSupport + 请求的极简对应):
// - 每个请求附带当前全部**未保存**的 TS / JS 标签(内容取 editor.store,CodeEditor 每次输入同步写入):按路径记版本,main 已确认
//   的版本只带版本号,内容变了才带全文;main 回 resync(重启 / 换根 / 版本不认识)→ 全部带全文重发一次。已保存的标签不带 ——
//   服务按磁盘内容算(与已保存内容相同)。
// - 预热:打开 TS / JS 文件时(CodeEditor 挂载)起服务并加载其项目(VSCode 打开 TS 文件即启动 tsserver),每个路径一次。
// - 服务崩溃(main 推送)→ 提示,文案同 VSCode。
// 窗口 id 不在这里传:main 取 IPC 发送方的窗口(popout 子窗的编辑器由主窗 renderer 渲染,同一个发送方)。
// BDD: src/__tests__/editor-go-to-definition/

import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { useEditorStore } from '@/stores/editor.store';
import { isUntitledPath } from '../../../electron/shared/untitled';
import {
  isTsLanguagePath,
  TS_DOC_TEXT_MAX,
  TS_DOCS_MAX,
  type TsDocState,
  type TsRequestOp,
  type TsRequestReply,
} from '../../../electron/shared/ts-language';

/** 本次 renderer 加载的标识(重载 → 新值,main 据此丢弃旧的未保存文档记录)。 */
const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let seq = 0;
const versions = new Map<string, { readonly text: string; readonly version: number }>();
/** main 已确认收到全文的版本。 */
const acked = new Map<string, number>();
const warmed = new Set<string>();
let unsubscribeEvents: (() => void) | null = null;

/** 语言服务能处理的文件(TS / JS 扩展名,有磁盘路径)。 */
export function isTsLanguageDocument(path: string): boolean {
  return isTsLanguagePath(path) && !isUntitledPath(path);
}

/** 当前要附带的未保存文档(已确认的版本不带全文)。 */
function currentDocs(): TsDocState[] {
  const out: TsDocState[] = [];
  const seen = new Set<string>();
  for (const tab of useEditorStore.getState().tabs) {
    if (out.length >= TS_DOCS_MAX) break;
    if (!tab.dirty || !isTsLanguageDocument(tab.filePath) || tab.content.length > TS_DOC_TEXT_MAX) continue;
    if (seen.has(tab.filePath)) continue;
    seen.add(tab.filePath);
    let v = versions.get(tab.filePath);
    if (!v || v.text !== tab.content) {
      v = { text: tab.content, version: ++seq };
      versions.set(tab.filePath, v);
    }
    out.push(acked.get(tab.filePath) === v.version ? { path: tab.filePath, version: v.version } : { path: tab.filePath, version: v.version, text: v.text });
  }
  for (const p of [...versions.keys()]) {
    if (!seen.has(p)) {
      versions.delete(p);
      acked.delete(p);
    }
  }
  return out;
}

function ensureEventSubscription(): void {
  if (unsubscribeEvents) return;
  unsubscribeEvents = coApi.tsLanguage.onEvent((e) => {
    notify.warn(t(e.fatal ? 'editor.ts_server.crashed_fatal' : 'editor.ts_server.crashed'));
  });
}

const FAILED: TsRequestReply = { status: 'unavailable', reason: 'error' };

/** 发请求(附带未保存文档;resync → 带全文重发一次)。不抛错:失败 → unavailable。 */
export async function requestTsLanguage(op: TsRequestOp): Promise<TsRequestReply> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let docs: TsDocState[];
    let r;
    try {
      docs = currentDocs();
      ensureEventSubscription();
      r = await coApi.tsLanguage.request({ clientId, docs, op });
    } catch {
      return FAILED;
    }
    if (!r.ok) return FAILED;
    if (r.data.status === 'resync') {
      acked.clear();
      continue;
    }
    for (const d of docs) if (d.text !== undefined) acked.set(d.path, d.version);
    return r.data;
  }
  return FAILED;
}

/** 打开 TS / JS 文件时预热(每个路径一次;失败忽略,下个请求会重试启动)。 */
export function warmTsLanguage(path: string): void {
  if (!isTsLanguageDocument(path) || warmed.has(path)) return;
  warmed.add(path);
  void requestTsLanguage({ kind: 'warmup', path });
}

/** 单测:重置客户端状态。 */
export function _resetTsLanguageClientForTest(): void {
  seq = 0;
  versions.clear();
  acked.clear();
  warmed.clear();
  unsubscribeEvents?.();
  unsubscribeEvents = null;
}
