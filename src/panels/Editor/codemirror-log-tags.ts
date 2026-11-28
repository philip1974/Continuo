// Log 语言(codemirror-log-language)的高亮 tag。单独成文件:主题(code-editor-theme)要给它们配色,而语言本身按需懒加载。
// 每个 tag 都挂在最接近的标准 tag 下(其它高亮样式 / 复制带格式文本按父 tag 也有颜色),主题再按日志语义细分。
// 对应 VSCode extensions/log/syntaxes/log.tmLanguage.json 的 scope(log.verbose / log.debug / ...)。
import { Tag, tags as t } from '@lezer/highlight';

export const logTags = {
  /** TRACE / [verbose] / 行首 V(comment log.verbose)。 */
  verbose: Tag.define(t.comment),
  /** DEBUG / [debug] / 行首 D(markup.changed log.debug)。 */
  debug: Tag.define(t.changed),
  /** INFO / NOTICE / [info] / 行首 I(markup.inserted log.info)。 */
  info: Tag.define(t.inserted),
  /** WARN / WARNING / [warn] / 行首 W(markup.deleted log.warning)。 */
  warning: Tag.define(t.deleted),
  /** ERROR / FATAL / FAIL / [error] / 行首 E(string.regexp, strong log.error)。 */
  error: Tag.define(t.invalid),
  /** 日期 / 时间(comment log.date)。 */
  date: Tag.define(t.comment),
  /** GUID、哈希、MAC、数字、true / false / null、0x…、URL、带点的名字(constant.language log.constant)。 */
  constant: Tag.define(t.atom),
  /** 引号字符串(string log.string)。 */
  string: Tag.define(t.string),
  /** …Exception 类型名(string.regexp, emphasis log.exceptiontype)。 */
  exceptionType: Tag.define(t.className),
  /** 异常栈帧行 `at …`(string.key, emphasis log.exception)。 */
  stackFrame: Tag.define(t.emphasis),
} as const;
