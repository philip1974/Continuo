// TS / JS 语言服务(转到定义)的 renderer ↔ main 协议(VSCode typescript-language-features 接 tsserver 的极简对应)。
// - 一个请求通道 REQUEST:每次请求附带编辑器里**未保存**的 TS / JS 文档(VSCode BufferSyncSupport 在每个请求前 flush 未同步的
//   变更,同一思路);文档按「路径 + 版本」去重:main 已有该版本的就不再带全文,main 缺版本时回 resync 让 renderer 补全文重发。
// - 一个推送通道 EVENT:服务进程崩溃(VSCode「The JS/TS language service crashed.」)。
// 位置一律 1 起的行 / 列(列 = UTF-16 code unit,与 CodeMirror、TS 的行内偏移同一单位):CodeMirror 文档按 LF 规整,而同步给服务的
// 是带原换行的文本,按偏移换算会在 CRLF 文件上错位,按行列不会。
// BDD: src/__tests__/editor-go-to-definition/

/** VSCode typescript-language-features 认的语言(typescript / typescriptreact / javascript / javascriptreact)的扩展名。 */
const TS_LANGUAGE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/** 路径是否由 TS / JS 语言服务处理(.d.ts 也是 .ts)。 */
export function isTsLanguagePath(path: string): boolean {
  return TS_LANGUAGE_FILE.test(path);
}

export const TS_LANGUAGE_CHANNELS = {
  REQUEST: 'ts-language:request',
  EVENT: 'ts-language:event',
} as const;

/** 单个未保存文档的文本上限(超出不同步,服务按磁盘内容算)。 */
export const TS_DOC_TEXT_MAX = 8 * 1024 * 1024;
/** 一次请求附带的未保存文档数上限。 */
export const TS_DOCS_MAX = 128;
export const TS_CLIENT_ID_MAX = 64;
/** 单次结果的定义数上限(超出截断)。 */
export const TS_DEFINITIONS_MAX = 100;
/** 预览文本(定义所在行)上限。 */
export const TS_PREVIEW_MAX = 200;

/** 未保存文档:text 缺省 = renderer 认为 main 已有该版本。 */
export interface TsDocState {
  readonly path: string;
  readonly version: number;
  readonly text?: string;
}

/** 请求槽:同一槽的新请求取消旧请求(悬停与命令各一槽,互不取消)。 */
export type TsRequestSlot = 'hover' | 'command';

export type TsRequestOp =
  /** 打开 TS / JS 文件时预热:起服务并加载该文件所属项目(VSCode 打开 TS 文件即激活扩展、启动 tsserver 并 open 文档)。 */
  | { readonly kind: 'warmup'; readonly path: string }
  | {
      readonly kind: 'definition';
      readonly slot: TsRequestSlot;
      readonly path: string;
      readonly line: number;
      readonly column: number;
    };

export interface TsRequestInput {
  /** renderer 每次加载随机生成:变了(窗口重载)→ main 丢弃旧的未保存文档记录。 */
  readonly clientId: string;
  readonly docs: readonly TsDocState[];
  readonly op: TsRequestOp;
}

/** 1 起的行 / 列区间(end 不含)。 */
export interface TsRange {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface TsLocation extends TsRange {
  readonly path: string;
  /** 定义所在行的文本(去首尾空白,限长;多结果选择器显示)。 */
  readonly preview: string;
}

export type TsUnavailableReason =
  | 'no-root' // 窗口没有打开文件夹
  | 'outside-root' // 文件不在窗口的工作区内
  | 'crashed' // 请求在途时服务进程崩溃
  | 'fatal' // 短时间内崩溃过多,不再重启(VSCode 同)
  | 'timeout'
  | 'error';

export type TsRequestReply =
  /** origin = 光标 / 鼠标处被解析的标识符区间(⌘ 悬停下划线);definitions 空 = 没有定义。 */
  | { readonly status: 'ok'; readonly origin: TsRange | null; readonly definitions: readonly TsLocation[] }
  /** main 缺这些文档的当前版本:带全文重发。 */
  | { readonly status: 'resync'; readonly paths: readonly string[] }
  /** 被同槽的新请求取代。 */
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable'; readonly reason: TsUnavailableReason };

/** fatal = 短时间内崩溃过多,不再自动重启。 */
export interface TsLanguageEvent {
  readonly kind: 'crashed';
  readonly fatal: boolean;
}

export function isTsLanguageEvent(v: unknown): v is TsLanguageEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.kind === 'crashed' && typeof e.fatal === 'boolean';
}

/** VSCode typescript.tsserver.maxTsServerMemory 的默认值(MB),对应 --max-old-space-size。 */
export const TS_SERVER_MAX_MEMORY_MB = 3072;
