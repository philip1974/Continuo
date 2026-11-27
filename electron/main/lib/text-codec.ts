// 编辑器文本读写的编码层(对齐 VSCode textfile encoding.ts:BOM 检测 detectEncodingByBOMFromBuffer、前 512 字节 0 字节启发式
// detectEncodingFromBuffer、iconv 编解码;VSCode 用 @vscode/iconv-lite-umd,这里用同源的 iconv-lite)。
// BDD: src/__tests__/editor-text-encoding/
//
// 数据安全(与 VSCode 的差异,刻意更严):
// - 解码必须**可逆**:按某编码解出的文本再按同一编码编码回去须与原字节逐字节相同(BOM 除外,另行记录)。否则拒绝
//  (VSCode 会用 U+FFFD / 替换字符打开,保存即不可逆地写坏原文件)。
// - 编码必须**无损**:文本中有该编码表示不了的字符(如以 GBK 保存 emoji)→ 拒绝写入(iconv-lite 与 VSCode 会静默写成 `?`)。
import iconv from 'iconv-lite';
import { encodingHasBom, type TextEncodingId } from '../../shared/text-encoding';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
/** VSCode ZERO_BYTE_DETECTION_BUFFER_MAX_LEN:只看前 512 字节判断二进制 / 无 BOM 的 UTF-16。 */
const ZERO_BYTE_DETECTION_MAX = 512;

export type DecodeOutcome =
  | { readonly ok: true; readonly text: string; readonly encoding: TextEncodingId }
  /**
   * binary:未指定编码且看起来是二进制(前 512 字节有 0 字节且不像 UTF-16)。
   * unknown-encoding:未指定编码,无 BOM、不是合法 UTF-8 但像文本 → 可让用户「通过编码重新打开」。
   * decode-failed:按(指定或 BOM 检测出的)编码无法可逆解码。
   */
  | { readonly ok: false; readonly reason: 'binary' | 'unknown-encoding' | 'decode-failed' };

/** VSCode detectEncodingByBOMFromBuffer。 */
export function detectEncodingByBom(bytes: Uint8Array): 'utf8bom' | 'utf16le' | 'utf16be' | null {
  if (bytes.length >= 2 && bytes[0] === UTF16BE_BOM[0] && bytes[1] === UTF16BE_BOM[1]) return 'utf16be';
  if (bytes.length >= 2 && bytes[0] === UTF16LE_BOM[0] && bytes[1] === UTF16LE_BOM[1]) return 'utf16le';
  if (bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    return 'utf8bom';
  }
  return null;
}

/**
 * VSCode detectEncodingFromBuffer 的 0 字节部分(无 BOM 时):前 512 字节里的 0 字节全在奇数位 → UTF-16 LE,全在偶数位 →
 * UTF-16 BE,其它位置有 0 字节 → 二进制。
 */
export function detectByZeroBytes(bytes: Uint8Array): 'utf16le' | 'utf16be' | 'binary' | null {
  let couldBeLE = true;
  let couldBeBE = true;
  let containsZero = false;
  const n = Math.min(bytes.length, ZERO_BYTE_DETECTION_MAX);
  for (let i = 0; i < n; i++) {
    const isEndian = i % 2 === 1;
    const isZero = bytes[i] === 0;
    if (isZero) containsZero = true;
    if (couldBeLE && ((isEndian && !isZero) || (!isEndian && isZero))) couldBeLE = false;
    if (couldBeBE && ((isEndian && isZero) || (!isEndian && !isZero))) couldBeBE = false;
    if (isZero && !couldBeLE && !couldBeBE) break;
  }
  if (!containsZero) return null;
  if (couldBeLE) return 'utf16le';
  if (couldBeBE) return 'utf16be';
  return 'binary';
}

function bomLength(id: TextEncodingId, bytes: Uint8Array): number {
  const bom = detectEncodingByBom(bytes);
  if (id === 'utf8' || id === 'utf8bom') return bom === 'utf8bom' ? 3 : 0;
  if (id === 'utf16le') return bom === 'utf16le' ? 2 : 0;
  if (id === 'utf16be') return bom === 'utf16be' ? 2 : 0;
  return 0; // 其它编码没有 BOM 概念:字节按该编码原样解码(VSCode 同)
}

function swapBytes16(bytes: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1]!;
    out[i + 1] = bytes[i]!;
  }
  return out;
}

/** 正文(不含 BOM)按编码可逆解码;不可逆 → null。 */
function decodeBody(body: Uint8Array, id: TextEncodingId): string | null {
  switch (id) {
    case 'utf8':
    case 'utf8bom':
      try {
        // fatal:非法序列(含超长编码 / 代理码点)一律拒绝 → 合法 UTF-8 与 JS 字符串一一对应,可逆
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
      } catch {
        return null;
      }
    case 'utf16le':
      // 奇数字节没有完整的码元:不能可逆
      return body.length % 2 === 0 ? Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf16le') : null;
    case 'utf16be':
      return body.length % 2 === 0 ? swapBytes16(body).toString('utf16le') : null;
    default: {
      const text = iconv.decode(Buffer.from(body.buffer, body.byteOffset, body.byteLength), id, { stripBOM: false });
      const back = iconv.encode(text, id, { addBOM: false });
      return Buffer.compare(back, Buffer.from(body.buffer, body.byteOffset, body.byteLength)) === 0 ? text : null;
    }
  }
}

/**
 * 解码编辑器要打开的文件字节。
 * - 未指定编码:BOM(UTF-8 / UTF-16 LE / BE)→ 按 BOM;否则 0 字节启发式(无 BOM 的 UTF-16 / 二进制);否则严格 UTF-8 →
 *   'utf8';不是合法 UTF-8 → unknown-encoding(VSCode files.autoGuessEncoding 默认关,这里同样不猜)。
 * - 指定编码(「通过编码重新打开」,VSCode getPreferredReadEncoding):按指定编码;指定 UTF-8 而文件带 UTF-8 BOM → 'utf8bom'。
 * 返回的 text 不含 BOM(BOM 由 encoding 表示,保存时按 encodingHasBom 写回)。
 */
export function decodeTextFile(bytes: Uint8Array, requested?: TextEncodingId): DecodeOutcome {
  let id: TextEncodingId;
  if (requested !== undefined) {
    id = requested === 'utf8' && detectEncodingByBom(bytes) === 'utf8bom' ? 'utf8bom' : requested;
  } else {
    const bom = detectEncodingByBom(bytes);
    if (bom !== null) {
      id = bom;
    } else {
      const zero = detectByZeroBytes(bytes);
      if (zero === 'binary') return { ok: false, reason: 'binary' };
      id = zero ?? 'utf8';
    }
  }
  const text = decodeBody(bytes.subarray(bomLength(id, bytes)), id);
  if (text !== null) return { ok: true, text, encoding: id };
  return { ok: false, reason: requested === undefined && id === 'utf8' ? 'unknown-encoding' : 'decode-failed' };
}

export type EncodeOutcome =
  | { readonly ok: true; readonly bytes: Buffer }
  /** 文本中第一个该编码表示不了的字符(整个码点)。 */
  | { readonly ok: false; readonly unencodable: string };

function bomBytes(id: TextEncodingId): readonly number[] {
  if (id === 'utf8bom') return UTF8_BOM;
  if (id === 'utf16le') return UTF16LE_BOM;
  if (id === 'utf16be') return UTF16BE_BOM;
  return [];
}

/** 第一个编码往返不一致的码点(只在编码失败时调用)。 */
function firstUnencodable(text: string, id: TextEncodingId): string {
  for (const ch of text) {
    if (iconv.decode(iconv.encode(ch, id, { addBOM: false }), id, { stripBOM: false }) !== ch) return ch;
  }
  return '';
}

/**
 * 把编辑器文本编码成要写盘的字节(含该编码要求的 BOM,见 encodingHasBom)。utf8 / utf8bom 与改动前的保存一致(Buffer utf-8);
 * UTF-16 可表示一切 JS 字符串;其它编码经 iconv 编码后解码回来比对,不一致 = 有表示不了的字符 → 拒绝。
 */
export function encodeTextFile(text: string, id: TextEncodingId): EncodeOutcome {
  let body: Buffer;
  switch (id) {
    case 'utf8':
    case 'utf8bom':
      body = Buffer.from(text, 'utf-8');
      break;
    case 'utf16le':
      body = Buffer.from(text, 'utf16le');
      break;
    case 'utf16be':
      body = swapBytes16(Buffer.from(text, 'utf16le'));
      break;
    default: {
      body = iconv.encode(text, id, { addBOM: false });
      if (iconv.decode(body, id, { stripBOM: false }) !== text) {
        return { ok: false, unencodable: firstUnencodable(text, id) };
      }
    }
  }
  if (!encodingHasBom(id)) return { ok: true, bytes: body };
  return { ok: true, bytes: Buffer.concat([Buffer.from(bomBytes(id)), body]) };
}
