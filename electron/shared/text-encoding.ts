// 编辑器文本文件编码(对齐 VSCode workbench/services/textfile/common/encoding.ts 的 SUPPORTED_ENCODINGS:id / 显示名 / 顺序
// 照抄,取常用子集)。main(解码 / 编码,见 electron/main/lib/text-codec)与 renderer(状态栏、选择器)共用这一份。
// 标签与 VSCode 一样不随界面语言翻译(编码名本身是专有名词)。BDD: src/__tests__/editor-text-encoding/

export const TEXT_ENCODINGS = {
  utf8: { labelLong: 'UTF-8', labelShort: 'UTF-8' },
  /** 只用于「通过编码保存」(VSCode encodeOnly):读取时 UTF-8 文件带不带 BOM 由文件本身决定。 */
  utf8bom: { labelLong: 'UTF-8 with BOM', labelShort: 'UTF-8 with BOM', encodeOnly: true },
  utf16le: { labelLong: 'UTF-16 LE', labelShort: 'UTF-16 LE' },
  utf16be: { labelLong: 'UTF-16 BE', labelShort: 'UTF-16 BE' },
  windows1252: { labelLong: 'Western (Windows 1252)', labelShort: 'Windows 1252' },
  iso88591: { labelLong: 'Western (ISO 8859-1)', labelShort: 'ISO 8859-1' },
  iso885915: { labelLong: 'Western (ISO 8859-15)', labelShort: 'ISO 8859-15' },
  windows1250: { labelLong: 'Central European (Windows 1250)', labelShort: 'Windows 1250' },
  windows1251: { labelLong: 'Cyrillic (Windows 1251)', labelShort: 'Windows 1251' },
  koi8r: { labelLong: 'Cyrillic (KOI8-R)', labelShort: 'KOI8-R' },
  gbk: { labelLong: 'Simplified Chinese (GBK)', labelShort: 'GBK' },
  gb18030: { labelLong: 'Simplified Chinese (GB18030)', labelShort: 'GB18030' },
  cp950: { labelLong: 'Traditional Chinese (Big5)', labelShort: 'Big5' },
  big5hkscs: { labelLong: 'Traditional Chinese (Big5-HKSCS)', labelShort: 'Big5-HKSCS' },
  shiftjis: { labelLong: 'Japanese (Shift JIS)', labelShort: 'Shift JIS' },
  eucjp: { labelLong: 'Japanese (EUC-JP)', labelShort: 'EUC-JP' },
  euckr: { labelLong: 'Korean (EUC-KR)', labelShort: 'EUC-KR' },
} as const satisfies Record<string, { labelLong: string; labelShort: string; encodeOnly?: true }>;

export type TextEncodingId = keyof typeof TEXT_ENCODINGS;

/** 选择器顺序(= 对象键顺序,即 VSCode order)。 */
export const TEXT_ENCODING_IDS = Object.keys(TEXT_ENCODINGS) as TextEncodingId[];

/** files.encoding 的默认值(VSCode 同):无 BOM、合法 UTF-8 的文件。 */
export const DEFAULT_TEXT_ENCODING: TextEncodingId = 'utf8';

export function isTextEncodingId(v: unknown): v is TextEncodingId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TEXT_ENCODINGS, v);
}

/** 写入时必带 BOM 的编码(VSCode getPreferredWriteEncoding:UTF-16 LE / BE 与 UTF-8 with BOM 强制 BOM)。 */
export function encodingHasBom(id: TextEncodingId): boolean {
  return id === 'utf8bom' || id === 'utf16le' || id === 'utf16be';
}

/** 「通过编码重新打开」可选的编码(去掉只能用于保存的 utf8bom,VSCode 同)。 */
export function isDecodableEncoding(id: TextEncodingId): boolean {
  return !('encodeOnly' in TEXT_ENCODINGS[id]);
}
