// 单行 Header:左 tab 列表 / 右 插件 actions。
//
// 与 VSCode 对齐:
//   - tabs=0  → 整个 header 不渲染(EditorWelcome 接管)
//   - tabs≥1 → 统一 TabNav,单 tab 也按内容宽收紧(TabNavItem flex-shrink:0
//              + max-width:220px),右侧 panel 留空,不再撑满整行。
//   - 不显文字「保存」按钮 — dirty 由 TabNavItem 自带的 ● 指示,⌘S 保存。
//   - markdown 模式切换(Edit/Source/Preview)已搬到 EditorPanel 中的 EditorModeBar
//     —— tab 行下方独立一行,与编辑器同宽,视觉上更干净。

import { memo, useMemo } from 'react';
import {
  getEffectiveMode,
  useEditorStore,
  type EditorMode,
} from '@/stores/editor.store';
import { useT, t as translate } from '@/i18n';
import { runContributedAction } from '@/lib/run-contributed-action';
import { basenameForEditorPath } from './editor-path-utils';
import {
  Button,
  IconButton,
  TabNav,
  TabNavItem,
} from '@/design';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import {
  filterVisible,
  type EditorActionSpec,
} from '@/plugins/registries/EditorActionRegistry';

/**
 * Tab 栏渲染所需的"chrome"子集(打磨 R23):只含标题/脏态相关字段,**不含
 * content** —— 让 EditorHeader 脱离编辑正文热路径。关闭确认也只需这三个字段。
 */
export interface TabChrome {
  readonly id: string;
  readonly filePath: string | null;
  readonly dirty: boolean;
}

interface EditorHeaderProps {
  onCloseRequest: (tab: TabChrome) => void;
}

function basename(p: string | null): string {
  // 可维护性 M12:非空 basename 规则共用 basenameForEditorPath;null fallback 文案各自处理。
  if (!p) return translate('panels.editor.untitled');
  return basenameForEditorPath(p);
}

/** 订阅 editorActions registry,渲染时按 ctx 过滤. */
function useEditorActions(): readonly EditorActionSpec[] {
  return useRegistry(coApp.editorActions);
}

/**
 * 抽出 actions 段为 memo 子组件:plugin 启停 actions 变化时,只本子组件
 * 重渲,父 EditorHeader 的 tabs 列表那段不动。
 *
 * memo 比较入参三个 primitive(filePath / dirty / mode)— 文件 / 脏态 /
 * 模式没变 + 子组件内 useEditorActions 订阅的 snapshot 也没变 → 跳过 reconcile。
 *
 * (filterVisible 仍每次 props 或 actions 变化时跑;空数组也安然 memo。)
 */
interface EditorActionsAreaProps {
  readonly filePath: string | null;
  readonly dirty: boolean;
  readonly mode: EditorMode;
}

const EditorActionsArea = memo(function EditorActionsArea({
  filePath,
  dirty,
  mode,
}: EditorActionsAreaProps) {
  const allActions = useEditorActions();
  const visibleActions = useMemo(
    () => filterVisible(allActions, { filePath, dirty, mode }),
    [allActions, filePath, dirty, mode],
  );
  return (
    <>
      {visibleActions.map((a) =>
        a.icon ? (
          <IconButton
            key={a.id}
            size="xs"
            // 插件贡献的编辑器 action,抛错经 runContributedAction 弹 error toast,不再
            // 静默吞(旧 `void a.fn()` 连 console 都没有)。见第二十一轮 P1-AX。
            onClick={() => runContributedAction(a.label, a.fn)}
            title={a.label}
            aria-label={a.label}
          >
            {a.icon}
          </IconButton>
        ) : (
          <Button
            key={a.id}
            variant="ghost"
            size="sm"
            onClick={() => runContributedAction(a.label, a.fn)}
            title={a.label}
          >
            {a.label}
          </Button>
        ),
      )}
    </>
  );
});

export function EditorHeader({ onCloseRequest }: EditorHeaderProps) {
  const t = useT(); // 订阅 locale 让 basename 改语言时 re-render
  // 只订阅派生的 tab chrome(打磨 R23):订阅一个 JSON 签名串(id/filePath/dirty),
  // 用户编辑正文时 tabs[].content 变但签名不变 → selector 返同一字符串 → React 跳过
  // 重渲;再用 useMemo 仅在签名变化时从 getState() 重建 chrome 对象数组。
  // (不用 useShallow:它逐元素 Object.is,每次 map 出的新对象永不相等 → 无限循环;
  // 不用 zustand/traditional 的 equalityFn:它需要未装的 use-sync-external-store。)
  const chromeSig = useEditorStore((s) =>
    JSON.stringify(s.tabs.map((tb) => [tb.id, tb.filePath, tb.dirty])),
  );
  const tabsChrome = useMemo<readonly TabChrome[]>(
    () =>
      useEditorStore.getState().tabs.map((tb) => ({
        id: tb.id,
        filePath: tb.filePath,
        dirty: tb.dirty,
      })),
    // chromeSig 故意作"失效键":body 用 getState() 读最新 tabs,签名变(chrome 真
    // 变)才重建对象数组。lint 看不到 body 引用 chromeSig 故误判 unnecessary。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chromeSig],
  );
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const switchTab = useEditorStore((s) => s.switchTab);
  // active tab 的派生 primitive,供右侧 action 区(打磨 R23 + 合并优化 R45)。
  // R23 用 3 个 selector 各 find;R45 合并为单次 find 构造 JSON 签名串,签名只放
  // **计算后的 effectiveMode**(不放 content)→ 正文变而 mode 不变时签名不变 → 不
  // 重渲,保持 R23 契约;每次 editor 更新从 3 次扫描降为 1 次。
  const activeActionSig = useEditorStore((s) => {
    const found = s.tabs.find((tb) => tb.id === s.activeTabId) ?? null;
    return JSON.stringify([
      found?.filePath ?? null,
      found?.dirty ?? false,
      getEffectiveMode(found),
    ]);
  });
  const { activeFilePath, dirty, effectiveMode } = useMemo(() => {
    const [filePath, d, mode] = JSON.parse(activeActionSig) as [
      string | null,
      boolean,
      EditorMode,
    ];
    return { activeFilePath: filePath, dirty: d, effectiveMode: mode };
  }, [activeActionSig]);

  if (tabsChrome.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch bg-canvas">
      <TabNav className="min-w-0 flex-1 overflow-x-auto">
        {tabsChrome.map((tab) => (
          <TabNavItem
            key={tab.id}
            active={tab.id === activeTabId}
            dirty={tab.dirty}
            title={tab.filePath ?? t('panels.editor.unsaved_draft')}
            onSelect={() => switchTab(tab.id)}
            onClose={() => onCloseRequest(tab)}
          >
            {basename(tab.filePath)}
          </TabNavItem>
        ))}
      </TabNav>

      {/* empty:hidden — 当无可见插件 action 时,本 div 的 children 全是 falsy
          /空 fragment,DOM 上是 :empty。隐藏避免空边框 + padding 在 tab 右侧
          形成"奇怪小矩形"。 */}
      <div className="flex shrink-0 items-center gap-2 border-l border-line px-3 text-xs empty:hidden">
        {/* 与 VSCode 对齐:不显「保存」按钮,dirty 走 TabNavItem 自带 ● + ⌘S */}

        {/* 插件贡献的 editor action(memo 子组件,plugin 启停时只本段重渲) */}
        <EditorActionsArea
          filePath={activeFilePath}
          dirty={dirty}
          mode={effectiveMode}
        />
      </div>
    </div>
  );
}
