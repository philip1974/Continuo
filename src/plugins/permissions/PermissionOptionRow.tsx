// 权限勾选行(首次授权弹窗 PermissionPrompt 与权限编辑 PermissionEditorModal 共用;此前两处逐字复制)。
// 标题 / 说明文案由 perm → PERM_LABEL_KEYS 单一来源给出。
//
// 用原生 checkbox:@/design 暂无 Checkbox 控件;样式只用语义 token(accent / fg / hover)。

import { useRef } from 'react';
import type { PermissionKey } from '../permissions';
import { useT } from '@/i18n';
import { PERM_LABEL_KEYS } from './perm-labels';

interface PermissionOptionRowProps {
  readonly perm: PermissionKey;
  readonly checked: boolean;
  /** activation:这次切换来自怎样的 click(detail:指针点击 ≥ 1,键盘 0;currentTarget:勾选框),供调用方防误触。 */
  readonly onToggle: (
    perm: PermissionKey,
    activation: { readonly detail: number; readonly currentTarget: Element },
  ) => void;
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
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <li>
      <label
        className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-hover"
        // 点在文字上:不走浏览器的 label → 勾选框转发(转发出的 click 不带指针点击的 detail,且焦点此刻才移到
        // 勾选框,调用方会把它当成键盘激活),直接以这次指针点击切换。
        onClick={(e) => {
          const input = inputRef.current;
          if (input === null || e.target === input) return;
          e.preventDefault();
          if (!disabled) onToggle(perm, { detail: e.detail, currentTarget: input });
        }}
      >
        <input
          ref={inputRef}
          type="checkbox"
          checked={checked}
          onChange={(e) =>
            onToggle(perm, {
              detail: (e.nativeEvent as UIEvent).detail,
              currentTarget: e.currentTarget,
            })
          }
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
