// 查找选项 toggle 组(区分大小写 Aa / 全字匹配 ab / 正则 .*):终端 / Markdown 查找条与在文件中查找视图共用 —— 同顺序、同字形、
// 同样式(对齐 VSCode findInput 的三个 toggle)。编辑器 CodeMirror 查找面板是 DOM 面板,用同一组字形与顺序(codemirror-find)。
// 名称 / tooltip 快捷键来自 src/lib/find-options。BDD: src/__tests__/find-options-parity/

import { IconButton } from '@/design';
import { useT } from '@/i18n';
import {
  FIND_OPTION_GLYPHS,
  FIND_OPTION_LABEL_KEYS,
  FIND_OPTIONS,
  FIND_OPTIONS_GROUP_KEY,
  findOptionTooltip,
  type FindOption,
} from './find-options';

interface FindOptionTogglesProps {
  readonly values: Readonly<Record<FindOption, boolean>>;
  readonly onToggle: (option: FindOption) => void;
  readonly className?: string;
}

/** role=group「搜索选项」内三个 aria-pressed 按钮,顺序 FIND_OPTIONS(Aa / ab / .*)。 */
export function FindOptionToggles({ values, onToggle, className }: FindOptionTogglesProps) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t(FIND_OPTIONS_GROUP_KEY)}
      className={`inline-flex shrink-0 items-center gap-0.5${className ? ` ${className}` : ''}`}
    >
      {FIND_OPTIONS.map((option) => {
        const label = t(FIND_OPTION_LABEL_KEYS[option]);
        return (
          <IconButton
            key={option}
            size="xs"
            aria-label={label}
            title={findOptionTooltip(label, option)}
            aria-pressed={values[option]}
            onClick={() => onToggle(option)}
          >
            {FIND_OPTION_GLYPHS[option]}
          </IconButton>
        );
      })}
    </div>
  );
}
