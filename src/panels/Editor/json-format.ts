// JSON 格式化(VSCode 自带 JSON 格式化程序 editor.action.formatDocument 的极简版):只重排 token 之间的空白,token 原样保留 ——
// 数字 / 字符串字面量逐字符不变(不经 JSON.parse → JSON.stringify:那会把 `1.0` 写成 `1`、`é` 写成 `é`、大整数丢精度、
// 重复键丢掉),注释(jsonc:tsconfig.json / settings.json)保留在原处(同行尾注释仍在同一行)。
// 格式:`{` / `[` 后换行缩进一层,`,` 后换行,`:` 后一个空格,空对象 / 空数组写成 `{}` / `[]`;缩进单位由调用方给(CodeMirror
// indentUnit,随文件缩进)。文末换行保持原样(有则保留一个,无则不加)。
// 尾逗号照常格式化、原样保留(VSCode jsonc-parser format 同款,.json / .jsonc 一样)。其它语法错误(去掉注释与尾逗号后 JSON.parse
// 不通过,如缺逗号)→ 返回 null,调用方提示且不改文档。
// BDD: src/__tests__/editor-language-commands/

type Token =
  | { readonly kind: 'punct'; readonly text: '{' | '}' | '[' | ']' | ',' | ':'; readonly line: number }
  | { readonly kind: 'value' | 'lineComment' | 'blockComment'; readonly text: string; readonly line: number };

/** 切成 token(带所在行号,判断注释是否与前一个 token 同行);未闭合的字符串 / 块注释 → null。 */
function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let line = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') {
      i++;
    } else if (c === '{' || c === '}' || c === '[' || c === ']' || c === ',' || c === ':') {
      out.push({ kind: 'punct', text: c, line });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') return null;
        j += src[j] === '\\' ? 2 : 1;
      }
      if (j >= src.length) return null;
      out.push({ kind: 'value', text: src.slice(i, j + 1), line });
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      out.push({ kind: 'lineComment', text: src.slice(i, j).replace(/\s+$/, ''), line });
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) return null;
      const text = src.slice(i, j + 2);
      out.push({ kind: 'blockComment', text, line });
      for (const ch of text) if (ch === '\n') line++;
      i = j + 2;
    } else {
      let j = i;
      while (j < src.length && !/[\s{}[\],:"/]/.test(src[j]!)) j++;
      if (j === i) return null; // 孤立的 `/`
      out.push({ kind: 'value', text: src.slice(i, j), line });
      i = j;
    }
  }
  return out;
}

/**
 * 去掉注释与尾逗号后是否为合法 JSON。注释、尾逗号(值后紧跟 `}` / `]` 的 `,`)按 jsonc 容忍 —— VSCode 的 JSON 格式化(jsonc-parser
 * format)只按 token 排版,.json 与 .jsonc 都照常格式化并保留尾逗号;其它语法错误(缺逗号、连续逗号、`[,]`)不容忍。
 */
function isValidJson(tokens: readonly Token[]): boolean {
  const code = tokens.filter((t) => t.kind === 'value' || t.kind === 'punct');
  const text = code
    .filter((t, i) => {
      if (t.text !== ',' || t.kind !== 'punct') return true;
      const next = code[i + 1]?.text;
      const prev = code[i - 1]?.text;
      const trailing = (next === '}' || next === ']') && prev !== undefined && !['{', '[', ',', ':'].includes(prev);
      return !trailing;
    })
    .map((t) => t.text)
    .join(' ');
  if (text === '') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 格式化后的全文;语法错误 → null。全是空白 / 只有注释 → 原样返回。
 * @param indent 一层缩进(如 '  ' / '    ' / '\t')
 */
export function formatJson(src: string, indent: string): string | null {
  const tokens = tokenize(src);
  if (tokens === null) return null;
  if (!tokens.some((t) => t.kind !== 'lineComment' && t.kind !== 'blockComment')) return src;
  if (!isValidJson(tokens)) return null;
  let level = 0;
  let out = '';
  const newline = (): string => '\n' + indent.repeat(level);
  tokens.forEach((tok, idx) => {
    const prev = idx > 0 ? tokens[idx - 1]! : undefined;
    const closes = tok.kind === 'punct' && (tok.text === '}' || tok.text === ']');
    if (closes) level--;
    if (prev) {
      const sameLine = tok.line === prev.line || (prev.kind === 'blockComment' && tok.line === prev.line + lineCount(prev.text));
      let sep: string;
      if (prev.kind === 'lineComment') sep = newline();
      else if (tok.kind === 'lineComment' || tok.kind === 'blockComment') sep = sameLine ? ' ' : newline();
      else if (prev.kind === 'punct' && (prev.text === '{' || prev.text === '[')) sep = closes ? '' : newline();
      else if (closes) sep = newline();
      else if (tok.kind === 'punct' && (tok.text === ',' || tok.text === ':')) sep = '';
      else if (prev.kind === 'punct' && prev.text === ',') sep = newline();
      else if (prev.kind === 'punct' && prev.text === ':') sep = ' ';
      else sep = prev.kind === 'blockComment' && !sameLine ? newline() : ' ';
      out += sep;
    }
    out += tok.text;
    if (tok.kind === 'punct' && (tok.text === '{' || tok.text === '[')) level++;
  });
  const bom = src.startsWith('\uFEFF') ? '\uFEFF' : '';
  return bom + (/\r?\n[ \t\r\n]*$/.test(src) ? out + '\n' : out);
}

function lineCount(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === '\n') n++;
  return n;
}
