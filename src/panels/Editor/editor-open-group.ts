// 打开文件(调用方没指定编辑器组)落在哪个组 —— 对齐 VSCode:编辑器服务按**获焦窗口**的编辑器区(EditorParts.activePart,随窗口
// focusin 更新)取活动组;主窗编辑器区总保留一个(可以是空的)组,把它的最后一组移到新窗口后主窗仍有空组,从主窗打开的文件落在主窗。
// Continuo 的活动编辑器组是全局的:组移到 popout 子窗后它就停在子窗,从主窗资源管理器 / ⌘P / 搜索结果 / 终端链接打开的文件此前都
// 落进子窗,焦点仍在主窗(接着打字进了主窗)。BDD: src/__tests__/popout-open-target/(打开文件)

import { getDockApi } from '@/shell/dock/dock-api-ref';
import { editorGroupInDocument, mainWindowAddPosition, popoutGroupOfDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import { editorGroupIdsOf, useEditorStore } from '@/stores/editor.store';
import { tWithFallback } from '@/i18n/translate';
import { nextEditorGroupId } from '../../../electron/shared/editor-group-id';

/**
 * 在 doc 所在窗口打开文件用的编辑器组;undefined = 照旧落活动编辑器组。
 * - 活动编辑器组的面板就在 doc 所在窗口(或 dock 未就绪 / 面板不在 dock 里)→ undefined
 * - 否则该窗口的编辑器组(editorGroupInDocument:该窗口活动面板 → 最近使用的组)
 * - 主窗没有编辑器组 → 在主窗新建一个空组(落点 mainWindowAddPosition)并返回它;popout 子窗里没有编辑器组 → undefined
 *   (子窗里只剩终端时照旧落活动组,同 Quick Open 的既有行为)
 * doc 缺省 = 触发命令的窗口(getCommandDocument,只在命令的同步部分有效 —— 有 await 的调用方须在开头读出 doc 传进来)。
 */
export function editorGroupForOpen(commandDoc?: Document): string | undefined {
  const api = getDockApi();
  if (!api) return undefined;
  const doc = commandDoc ?? getCommandDocument();
  const s = useEditorStore.getState();
  const active = api.getPanel(s.activeGroupId);
  if (!active) return undefined;
  const popout = doc === document ? undefined : popoutGroupOfDocument(api, doc);
  if (doc !== document && !popout) return undefined; // 子窗已关
  const activeInDoc = popout ? active.group === popout : active.api.location.type !== 'popout';
  if (activeInDoc) return undefined;
  const here = editorGroupInDocument(api, doc, s.activeGroupId);
  if (here !== undefined || popout) return here;
  return createMainWindowEditorGroup();
}

/** 在主窗新建空编辑器组(store 组 + dock 面板),成为活动组;组数已达上限 / dock 未就绪 → undefined。 */
function createMainWindowEditorGroup(): string | undefined {
  const api = getDockApi();
  if (!api) return undefined;
  const s = useEditorStore.getState();
  const id = nextEditorGroupId([...editorGroupIdsOf(s), ...api.panels.map((p) => p.id)]);
  if (!s.splitGroup(s.activeGroupId, id, null)) return undefined;
  const position = mainWindowAddPosition(api);
  api.addPanel({
    id,
    component: 'editor',
    title: tWithFallback('panels.editor.title', 'Editor'),
    params: { titleKey: 'panels.editor.title' },
    ...(position ? { position } : {}),
  });
  return id;
}
