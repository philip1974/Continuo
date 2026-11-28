/*---------------------------------------------------------------------------------------------
 *  Ported from microsoft/vscode extensions/log/syntaxes/log.tmLanguage.json
 *  (converted there from emilast/vscode-logfile-highlighter syntaxes/log.tmLanguage, MIT, Copyright (c) 2015 emilast)
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *--------------------------------------------------------------------------------------------*/
// 日志文件语法高亮(VSCode 内置 Log 语言;BDD: src/__tests__/code-editor-language/)。TextMate 语法的规则按原顺序移植成一个
// 交替正则:TextMate 在当前位置之后取**最早开始**的匹配、同位置按规则顺序 —— 与 JS 正则交替(从 lastIndex 起最左匹配、同起点按
// 分支顺序)一致,每个 token 一次 exec。移植差异(JS 正则与 Oniguruma):`(?i)` 写成逐字母大小写字符类;`{2,}+`(占有量词)
// 写成 `{2,}`;行首前缀里的 `\p` 按标点 `\p{P}` 理解(时间戳的 `-` `:` `.`)。begin / end 规则(`at …` 栈帧)直接取到行尾。

import { LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import { logTags } from './codemirror-log-tags';

/** 'debug' → '[Dd][Ee][Bb][Uu][Gg]'(Oniguruma `(?i)` 的等价写法)。 */
const ci = (word: string): string =>
  [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)).join('');
const ciAlt = (...words: string[]): string => words.map(ci).join('|');

// 行首只有空白 / 数字 / 标点(时间戳)时的单字母级别。
const LINE_PREFIX = '(?<=^[\\s\\d\\p{P}]*)';

type LogToken = keyof typeof logTags;

/** [token, 正则源](顺序 = 原语法 patterns 顺序;各源内部只用非捕获组)。 */
const RULES: ReadonlyArray<readonly [LogToken, string]> = [
  ['verbose', '\\b(?:[Tt]race|TRACE)\\b:?'],
  ['verbose', `\\[(?:${ciAlt('verbose', 'verb', 'vrb', 'vb', 'v')})\\]`],
  ['verbose', `${LINE_PREFIX}\\bV\\b`],
  ['debug', `\\b(?:DEBUG|Debug)\\b|\\b${ci('debug')}:`],
  ['debug', `\\[(?:${ciAlt('debug', 'dbug', 'dbg', 'de', 'd')})\\]`],
  ['debug', `${LINE_PREFIX}\\bD\\b`],
  ['info', `\\b(?:HINT|INFO|INFORMATION|Info|NOTICE|II)\\b|\\b(?:${ciAlt('info', 'information')}):`],
  ['info', `\\[(?:${ciAlt('information', 'info', 'inf', 'in', 'i')})\\]`],
  ['info', `${LINE_PREFIX}\\bI\\b`],
  ['warning', `\\b(?:WARNING|WARN|Warn|WW)\\b|\\b${ci('warning')}:`],
  ['warning', `\\[(?:${ciAlt('warning', 'warn', 'wrn', 'wn', 'w')})\\]`],
  ['warning', `${LINE_PREFIX}\\bW\\b`],
  ['error', `\\b(?:ALERT|CRITICAL|EMERGENCY|ERROR|FAILURE|FAIL|Fatal|FATAL|Error|EE)\\b|\\b${ci('error')}:`],
  ['error', `\\[(?:${ciAlt('error', 'eror', 'err', 'er', 'e', 'fatal', 'fatl', 'ftl', 'fa', 'f')})\\]`],
  ['error', `${LINE_PREFIX}\\bE\\b`],
  ['date', '\\b\\d{4}-\\d{2}-\\d{2}(?=T|\\b)'],
  ['date', '(?<=^|\\s)\\d{2}[^\\w\\s]\\d{2}[^\\w\\s]\\d{4}\\b'],
  ['date', 'T?\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?(?:Z| ?[+\\-]\\d{1,2}:\\d{2})?\\b'],
  ['date', 'T\\d{2}\\d{2}(?:\\d{2}(?:[.,]\\d+)?)?(?:Z| ?[+\\-]\\d{1,2}\\d{2})?\\b'],
  ['constant', '\\b(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{10}|[0-9a-fA-F]{7})\\b'],
  ['constant', '\\b[0-9a-fA-F]{8}-?(?:[0-9a-fA-F]{4}-?){3}[0-9a-fA-F]{12}\\b'],
  ['constant', '\\b(?:[0-9a-fA-F]{2,}[:\\-])+[0-9a-fA-F]{2,}\\b'],
  ['constant', '\\b(?:[0-9]+|true|false|null)\\b'],
  ['constant', '\\b0x[a-fA-F0-9]+\\b'],
  ['string', '"[^"]*"'],
  ['string', "(?<!\\w)'[^']*'"],
  ['exceptionType', '\\b[a-zA-Z.]*Exception\\b'],
  // begin `^[\t ]*at[\t ]`,end `$`:整行余下部分
  ['stackFrame', '^[\\t ]*at[\\t ]'],
  ['constant', '\\b[a-z]+:\\/\\/\\S+\\b\\/?'],
  ['constant', '(?<![\\w/\\\\])(?:[\\w\\-]+\\.)+[\\w\\-]+(?![\\w/\\\\])'],
];

const RULE_RE = new RegExp(RULES.map(([, src]) => `(${src})`).join('|'), 'gu');

/** 测试用:一行的 token 序列 [文本, token | null]。 */
export function tokenizeLogLine(line: string): Array<[string, LogToken | null]> {
  const out: Array<[string, LogToken | null]> = [];
  let pos = 0;
  while (pos < line.length) {
    const [token, end] = nextToken(line, pos);
    out.push([line.slice(pos, end), token]);
    pos = end;
  }
  return out;
}

/** 从 pos 起的下一个 token:[token, 终点];到下一个匹配之前的文本为 null。 */
function nextToken(line: string, pos: number): [LogToken | null, number] {
  RULE_RE.lastIndex = pos;
  const m = RULE_RE.exec(line);
  if (!m) return [null, line.length];
  if (m.index > pos) return [null, m.index];
  let i = 1;
  while (m[i] === undefined) i++;
  const token = RULES[i - 1]![0];
  if (token === 'stackFrame') return [token, line.length];
  // 规则都不匹配空串;防御:至少前进一个字符
  return [token, Math.max(pos + 1, pos + m[0].length)];
}

// StreamLanguage 解析 token 名时先查内置的旧 CodeMirror 5 名字表(`error` → invalid、`type`、`header` …),命中就不看
// tokenTable —— 直接用 `error` 作 token 名,ERROR / FATAL 会被当成 t.invalid、主题里 logTags.error 的红色粗体不生效。
// 所以对外的 token 名统一加 `log` 前缀(logError / logString …),保证只从这张表解析。
const tokenName = (token: LogToken): string => `log${token[0]!.toUpperCase()}${token.slice(1)}`;
const TOKEN_TABLE = Object.fromEntries(
  (Object.keys(logTags) as LogToken[]).map((token) => [tokenName(token), logTags[token]]),
);

const logParser: StreamParser<null> = {
  name: 'log',
  token(stream) {
    const [token, end] = nextToken(stream.string, stream.pos);
    stream.pos = end;
    return token && tokenName(token);
  },
  tokenTable: TOKEN_TABLE,
};

export function logLanguageSupport(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(logParser));
}
