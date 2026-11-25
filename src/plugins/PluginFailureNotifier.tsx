// 插件失败的主动提示(BDD: src/__tests__/plugin-failure-notify/)。对齐 VSCode「Activating extension 'x' failed」通知。
// 订阅插件列表而非在 PluginManager 里直接 notify:启动期激活可能早于通知层(NotificationsProvider)挂载,
// 挂载时按当前列表补发;激活失败与渲染出错(RENDER_FAILED)走同一出口、同一去重。

import { useEffect, useRef } from 'react';
import { t } from '@/i18n';
import { notify } from '@/notifications/notify';
import type { PluginListItem } from './PluginManager';
import { localizePluginError } from './plugin-error-text';
import { useUserPluginList } from './use-user-plugin-list';

/** 被禁用 / 卸载中止的激活:不是失败(随后落 disabled / 移除)。 */
const NOT_A_FAILURE = new Set(['ACTIVATION_ABORTED', 'NOT_INSTALLED']);

/**
 * 本次列表中需要新通知的失败插件;notified(插件 id → 已通知的失败签名)就地更新:离开 failed 的插件移除,
 * 之后再失败会再通知。
 */
export function collectNewPluginFailures(
  list: readonly PluginListItem[],
  notified: Map<string, string>,
): PluginListItem[] {
  const out: PluginListItem[] = [];
  const present = new Set<string>();
  for (const p of list) {
    present.add(p.id);
    if (p.status !== 'failed' || !p.error || NOT_A_FAILURE.has(p.error.code)) {
      notified.delete(p.id);
      continue;
    }
    const signature = `${p.error.code}\0${p.error.message}`;
    if (notified.get(p.id) === signature) continue;
    notified.set(p.id, signature);
    out.push(p);
  }
  for (const id of [...notified.keys()]) if (!present.has(id)) notified.delete(id);
  return out;
}

export function PluginFailureNotifier(): null {
  const list = useUserPluginList();
  const notified = useRef(new Map<string, string>());
  useEffect(() => {
    for (const p of collectNewPluginFailures(list, notified.current)) {
      notify.error(t('plugins_tab.notify.failed', { name: p.manifest.name, reason: localizePluginError(p.error!) }), {
        code: p.error!.code,
      });
    }
  }, [list]);
  return null;
}
