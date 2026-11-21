// 授权类弹窗里「这次授予没有生效」的提示(配合 use-prompt-grant-guard)。
//
// 守卫拒掉的激活此前没有任何反馈:过早的点击、Tab 后立刻回车、辅助技术合成的点击(detail=0、没有 keydown、
// DOM 焦点可能不在按钮上)都只是「没反应」。role=status 的区域常驻(读屏只播报之后出现的内容),被拒时写入提示,
// 可见且会被播报;常驻一行高度,提示出现时弹窗不跳动。

import { useSyncExternalStore } from 'react';
import { useT } from '@/i18n';
import type { PromptGrantGuard } from './use-prompt-grant-guard';

export function PromptGrantHint({ guard }: { readonly guard: PromptGrantGuard }) {
  const t = useT();
  const rejected = useSyncExternalStore(guard.subscribeRejected, guard.wasRejected);
  return (
    <p role="status" className="mt-2 min-h-4 text-right text-2xs text-fg-dim">
      {rejected ? t('permissions.grant_guard.rejected') : null}
    </p>
  );
}
