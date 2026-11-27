// 编辑器 tab 的编码 / 行尾(对齐 VSCode 状态栏编码 / 行尾项与 changeEncoding / changeEOL)。纯函数,store / 状态栏 / 命令共用。
// BDD: src/__tests__/editor-text-encoding/
import type { EditorTab } from '@/stores/editor.store';
import type { FsReadFileResult } from '../../../electron/shared/fs-channels';
import { TEXT_ENCODINGS, type TextEncodingId } from '../../../electron/shared/text-encoding';

/** tab 的磁盘编码(缺省 utf8)。 */
export function tabEncodingOf(tab: Pick<EditorTab, 'encoding'>): TextEncodingId {
  return tab.encoding ?? 'utf8';
}

/** 读盘结果所用编码(缺省 utf8)。 */
export function readEncodingOf(r: Extract<FsReadFileResult, { ok: true }>): TextEncodingId {
  return r.encoding ?? 'utf8';
}

/**
 * 为既有 tab 读盘(外部同步 / 还原 / 保存前比对 / 冲突比较)时的解码选项:用户选定过编码 → 按它解码(VSCode preferredEncoding);
 * 否则自动识别(BOM / UTF-8),与打开时同口径。
 */
export function readOptionsForTab(
  tab: Pick<EditorTab, 'encoding' | 'encodingPinned'> | null | undefined,
): { readonly encoding: TextEncodingId } | undefined {
  return tab?.encodingPinned === true ? { encoding: tabEncodingOf(tab) } : undefined;
}

/** 状态栏显示名(VSCode labelShort)。 */
export function encodingLabelShort(id: TextEncodingId): string {
  return TEXT_ENCODINGS[id].labelShort;
}

export type LineEnding = 'LF' | 'CRLF';

/**
 * 文件行尾(与 CodeEditor 回写拼接同口径:所有换行都是 CRLF 才算 CRLF,否则 LF —— LF / 混合 / 无换行;混合文件编辑后统一为 LF)。
 */
export function detectLineEnding(text: string): '\r\n' | '\n' {
  let crlf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (text.charCodeAt(i - 1) !== 13) return '\n';
    crlf++;
  }
  // 还有孤立 \r(老 Mac 换行)也算混合
  return crlf > 0 && !/\r(?!\n)/.test(text) ? '\r\n' : '\n';
}

export function lineEndingOf(text: string): LineEnding {
  return detectLineEnding(text) === '\r\n' ? 'CRLF' : 'LF';
}

/** 把全部换行(CRLF / LF / 孤立 CR)统一成 eol(VSCode pushEOL 对整篇生效)。 */
export function convertLineEndings(text: string, eol: LineEnding): string {
  return text.replace(/\r\n|\r|\n/g, eol === 'CRLF' ? '\r\n' : '\n');
}
