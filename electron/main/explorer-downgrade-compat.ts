// explorer.json 降级兼容:0.2.15 的 v3 schema 是 strict(不认识的字段 = 损坏 → 用默认值覆盖、原文只留在一次性的
// explorer.json.corrupt)。之后新增的字段(窗口几何、搜索输入、编辑器组 / 固定 tab / 视图状态 / 编码、按文件夹快照、
// openWindowSeqs …)一旦写进 explorer.json,回退到 0.2.15 整个会话就被清空,再升级也找不回。
//
// 做法(对齐 VSCode 的「旧版本读不懂的状态不进它要读的文件」:VSCode 各项状态是 state.vscdb 里的独立键,旧版本只读它认识的键):
// - explorer.json 只写 0.2.15 认识的字段(下方 LEGACY_* 白名单;守护测试拿 0.2.15 原 schema 快照校验写出的文件)。
// - 其余字段写旁挂文件 explorer-ext.json(按 windowSeq 对应窗口段),读时合并回去。旁挂文件缺失 / 损坏 → 只用 explorer.json(丢的只是新增字段)。
// - 旁挂文件记录写它时 explorer.json 原文的摘要。读时摘要不符 = explorer.json 被别人(旧版本)改过 / 两次写之间崩溃:
//   只合并按路径 / 窗口独立、不会与旧版本的改动冲突的字段(几何、搜索、视图状态、编码、Markdown 模式、文件夹快照),
//   丢掉描述 tab 结构的字段(编辑器组、MRU、预览 / 固定 tab、openWindowSeqs)—— 它们对应的是旧版本改动之前的 tab 列表。
// BDD: src/__tests__/explorer-downgrade-compat/
import crypto from 'node:crypto';
import path from 'node:path';
import type { ExplorerPayloadV3 } from '../shared/explorer-persistence-schema';

/** 0.2.15 explorer.json(v3)各层认识的字段。 */
const LEGACY_TOP_KEYS = new Set(['version', 'workspace', 'pinned', 'nextWindowSeq', 'restoreAllWindowsOnLaunch', 'windows']);
const LEGACY_WINDOW_KEYS = new Set(['windowSeq', 'workspace', 'explorer', 'layoutUi', 'editor', 'layout', 'lastClosedAt']);
const LEGACY_EDITOR_KEYS = new Set(['openFilePaths', 'activePath']);

/** 描述 tab 结构的字段:explorer.json 被旧版本改过时与它的 tab 列表不再对应,不合并。 */
const STRUCTURAL_TOP_KEYS = new Set(['openWindowSeqs']);
const STRUCTURAL_EDITOR_KEYS = new Set(['mruPaths', 'previewPath', 'stickyPaths', 'groups', 'activeGroup', 'groupMru']);

const EXT_VERSION = 1 as const;

type Obj = Record<string, unknown>;

interface ExtWindow {
  windowSeq: number;
  fields: Obj;
  editor?: Obj;
}

/** 旁挂文件内容。 */
export interface ExplorerExtFile {
  version: typeof EXT_VERSION;
  /** 同次写出的 explorer.json 原文的 sha256。 */
  legacyHash: string;
  top: Obj;
  windows: ExtWindow[];
}

export function explorerExtFilePath(explorerFile: string): string {
  const dir = path.dirname(explorerFile);
  const base = path.basename(explorerFile).replace(/\.json$/, '');
  return path.join(dir, `${base}-ext.json`);
}

export function hashExplorerText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function partition(src: Obj, legacyKeys: ReadonlySet<string>): { legacy: Obj; extra: Obj | null } {
  const legacy: Obj = {};
  let extra: Obj | null = null;
  for (const k of Object.keys(src)) {
    if (legacyKeys.has(k)) legacy[k] = src[k];
    else (extra ??= {})[k] = src[k];
  }
  return { legacy, extra };
}

/** 拆成 0.2.15 能读的 explorer.json 内容与新增字段(无新增字段时 ext 为 null)。 */
export function splitExplorerPayload(payload: ExplorerPayloadV3): {
  legacy: ExplorerPayloadV3;
  ext: Omit<ExplorerExtFile, 'legacyHash'> | null;
} {
  const { legacy, extra: topExtra } = partition(payload as unknown as Obj, LEGACY_TOP_KEYS);
  const extWindows: ExtWindow[] = [];
  legacy['windows'] = payload.windows.map((w) => {
    const { legacy: lw, extra } = partition(w as unknown as Obj, LEGACY_WINDOW_KEYS);
    let editorExtra: Obj | null = null;
    if (isObj(lw['editor'])) {
      const e = partition(lw['editor'], LEGACY_EDITOR_KEYS);
      lw['editor'] = e.legacy;
      editorExtra = e.extra;
    }
    if (extra || editorExtra) {
      extWindows.push({ windowSeq: w.windowSeq, fields: extra ?? {}, ...(editorExtra ? { editor: editorExtra } : {}) });
    }
    return lw;
  });
  const ext = topExtra || extWindows.length > 0 ? { version: EXT_VERSION, top: topExtra ?? {}, windows: extWindows } : null;
  return { legacy: legacy as unknown as ExplorerPayloadV3, ext };
}

/** payload 是否含 0.2.15 不认识的字段(需要拆分后重写)。 */
export function hasExtFields(payload: ExplorerPayloadV3): boolean {
  return splitExplorerPayload(payload).ext !== null;
}

/** 解析旁挂文件外壳(字段内容由合并后的整体 schema 校验);不合法 → null。 */
export function parseExplorerExt(text: string): ExplorerExtFile | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(json) || json['version'] !== EXT_VERSION || typeof json['legacyHash'] !== 'string') return null;
  if (!isObj(json['top']) || !Array.isArray(json['windows'])) return null;
  const windows: ExtWindow[] = [];
  for (const w of json['windows']) {
    if (!isObj(w) || !Number.isSafeInteger(w['windowSeq']) || !isObj(w['fields'])) return null;
    if (w['editor'] !== undefined && !isObj(w['editor'])) return null;
    windows.push({
      windowSeq: w['windowSeq'] as number,
      fields: w['fields'],
      ...(w['editor'] ? { editor: w['editor'] } : {}),
    });
  }
  return { version: EXT_VERSION, legacyHash: json['legacyHash'], top: json['top'], windows };
}

function assignNew(target: Obj, src: Obj, legacyKeys: ReadonlySet<string>, skip: ReadonlySet<string>): void {
  for (const k of Object.keys(src)) {
    // 旁挂文件只补新增字段:0.2.15 认识的字段以 explorer.json 为准;explorer.json 自己已带的(旧的未拆分文件)也以它为准。
    if (legacyKeys.has(k) || skip.has(k) || Object.hasOwn(target, k)) continue;
    target[k] = src[k];
  }
}

/**
 * 把旁挂文件的新增字段合并进 explorer.json 解析出的 JSON(尚未过 schema:调用方对合并结果做一次整体校验,不合法再单独校验
 * explorer.json —— 常见路径只校验一次)。`exact` = 旁挂文件记录的摘要与 explorer.json 原文一致;否则不合并 tab 结构字段。
 * 外形不对(非 v3 对象)→ 原样返回。
 */
export function mergeExplorerExt(base: unknown, ext: ExplorerExtFile, exact: boolean): unknown {
  if (!isObj(base) || base['version'] !== 3 || !Array.isArray(base['windows'])) return base;
  const none = new Set<string>();
  const merged = { ...base };
  assignNew(merged, ext.top, LEGACY_TOP_KEYS, exact ? none : STRUCTURAL_TOP_KEYS);
  const extBySeq = new Map<number, ExtWindow>();
  for (const w of ext.windows) if (!extBySeq.has(w.windowSeq)) extBySeq.set(w.windowSeq, w);
  merged['windows'] = (base['windows'] as unknown[]).map((w) => {
    if (!isObj(w)) return w;
    const e = extBySeq.get(w['windowSeq'] as number);
    if (!e) return w;
    extBySeq.delete(e.windowSeq); // 同一 windowSeq 的重复段只补首个(与 findWindowEntryBySeq 命中首个一致)
    const out = { ...w };
    assignNew(out, e.fields, LEGACY_WINDOW_KEYS, none);
    if (e.editor && isObj(out['editor'])) {
      const editor = { ...out['editor'] };
      assignNew(editor, e.editor, LEGACY_EDITOR_KEYS, exact ? none : STRUCTURAL_EDITOR_KEYS);
      out['editor'] = editor;
    }
    return out;
  });
  return merged;
}

/**
 * 会话里没有任何用户数据(0.2.15 把新版文件当损坏、用默认值重建后的样子):无最近目录 / 固定项,各窗口都没打开文件夹与文件。
 * 此时从 explorer.json.corrupt 恢复不会丢任何东西。
 */
export function isEmptyExplorerSession(payload: ExplorerPayloadV3): boolean {
  if (payload.workspace.recentRoots.length > 0 || payload.pinned.paths.length > 0) return false;
  if ((payload.workspaceSnapshots?.length ?? 0) > 0) return false;
  return payload.windows.every(
    (w) => w.workspace.root === null && (w.editor?.openFilePaths.length ?? 0) === 0,
  );
}
