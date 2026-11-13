// 权限勾选行(首次授权弹窗 PermissionPrompt 与权限编辑 PermissionEditorModal 共用;此前两处逐字复制)。
// 标题 / 说明文案由 perm → PERM_LABEL_KEYS 单一来源给出。
//
// 用原生 checkbox:@/design 暂无 Checkbox 控件;样式只用语义 token(accent / fg / hover)。

import type { PermissionKey } from '../permissions';
import { useT } from '@/i18n';
import { PERM_LABEL_KEYS } from './perm-labels';

interface PermissionOptionRowProps {
  readonly perm: PermissionKey;
  readonly checked: boolean;
  readonly onToggle: (perm: PermissionKey) => void;
  readonly disabled?: boolean;
}

export function PermissionOptionRow({
  perm,
  checked,
  onToggle,
  disabled,
}: PermissionOptionRowProps) {
  const t = useT();
  const meta = PERM_LABEL_KEYS[perm];
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-hover">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(perm)}
          disabled={disabled}
          className="mt-0.5 accent-accent"
        />
        <div className="flex-1 text-xs">
          <div className="font-medium text-fg">{t(meta.titleKey)}</div>
          <div className="text-fg-dim">{t(meta.descKey)}</div>
        </div>
      </label>
    </li>
  );
}
