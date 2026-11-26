// Quick Open 的「转到行 / 列」模式(VSCode GotoLineQuickAccessProvider:查询以 `:` 开头)。纯函数:解析与夹取。
// BDD: src/__tests__/editor-goto-line/

/** 转到行模式的查询前缀(VSCode 同:⌃G 打开 Quick Open 并预填它)。 */
export const GOTO_LINE_PREFIX = ':';

export function isGotoLineQuery(query: string): boolean {
  return query.startsWith(GOTO_LINE_PREFIX);
}

/** 解析出的目标:行号可为负(从末尾数,-1 = 最后一行,VSCode 同);列可缺省。 */
export interface GotoLineRequest {
  readonly line: number;
  readonly column?: number;
}

/**
 * `:行`、`:行:列`(也认 `行,列` / `行#列`,VSCode parsePosition 同一分隔符)→ 目标;没有数字(只有 `:`、`:abc`)或行为 0 → null。
 */
export function parseGotoLineQuery(query: string): GotoLineRequest | null {
  if (!isGotoLineQuery(query)) return null;
  const numbers: number[] = [];
  for (const part of query.slice(GOTO_LINE_PREFIX.length).trim().split(/[,:#]/)) {
    const n = Number.parseInt(part.trim(), 10);
    if (!Number.isNaN(n)) numbers.push(n);
  }
  const line = numbers[0];
  if (line === undefined || line === 0) return null;
  const column = numbers[1];
  return column === undefined ? { line } : { line, column };
}

/** 文档的行数与各行长度(CodeMirror Text 满足)。 */
export interface GotoLineDoc {
  readonly lines: number;
  line(n: number): { readonly length: number };
}

/**
 * 夹到文档范围内:行号越界 → 第 1 行 / 最后一行;负数行从末尾数;列 < 1 视为未给,超出行长 → 行尾(行长 + 1)。
 */
export function clampGotoLine(req: GotoLineRequest, doc: GotoLineDoc): GotoLineRequest {
  const raw = req.line > 0 ? req.line : doc.lines + 1 + req.line;
  const line = Math.min(Math.max(raw, 1), doc.lines);
  if (req.column === undefined || req.column < 1) return { line };
  return { line, column: Math.min(req.column, doc.line(line).length + 1) };
}
