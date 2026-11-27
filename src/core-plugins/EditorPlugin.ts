// 内置 Editor 插件(吃自家狗粮,验证 Plugin API,M-Plugin v1.7)。
// 把原 panels.tsx 硬编码的 'editor' 渲染搬进来,通过 registerPanel 贡献。
// codemirror + milkdown + prosemirror + katex 全部走 lazy chunk,不进主 bundle。
// 面板 chunk 走共享加载器:openFile({line}) 冷路径预加载与这里共用同一 promise。

import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { loadEditorPanelModule } from '@/panels/Editor/editor-engine-loaders';
import { editorCommandSpecs } from '@/panels/Editor/editor-commands';
import { encodingCommandSpecs } from '@/plugins/editor-encoding/encoding-actions';
import { indentationCommandSpecs } from '@/plugins/editor-encoding/indentation-actions';
import { installIndentationSync } from '@/panels/Editor/editor-indentation';
import { editorTextCommandSpecs } from '@/panels/Editor/editor-text-commands';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { installNavigationHistory } from '@/panels/Editor/navigation-history';
import { installEditorPreviewSettingSync } from '@/panels/Editor/editor-preview';
import { CONFLICT_DIFF_PANEL_TYPE } from '@/panels/Editor/conflict-diff-constants';
import { conflictCompareCommandSpecs } from '@/panels/Editor/conflict-compare';

const Editor = lazy(() =>
  loadEditorPanelModule().then((m) => ({ default: m.EditorPanel })),
);
// 保存冲突差异 tab(@codemirror/merge 只在这个 chunk 里;BDD: src/__tests__/editor-save-conflict-compare/)
const ConflictDiff = lazy(() => import('@/panels/Editor/ConflictDiffPanel').then((m) => ({ default: m.ConflictDiffPanel })));

export default class EditorPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'editor',
      title: 'Editor',
      titleKey: 'panels.editor.title',
      factory: lazyPanel(Editor),
    });
    this.registerPanel({
      type: CONFLICT_DIFF_PANEL_TYPE,
      title: 'Resolve Save Conflict',
      titleKey: 'panels.editor.conflict_diff.panel_title',
      factory: lazyPanel(ConflictDiff),
      // 每个文档一个(id 带 tab id),只由「比较」带 params 打开:不进「⋯」菜单;多实例 → dock 重建时不当作重复单例关掉
      hidden: true,
      multiInstance: true,
    });
    // 差异 tab 上的「接受我的版本 / 使用磁盘版本」(VSCode workbench.files.action.acceptLocalChanges / revertLocalChanges)
    for (const spec of conflictCompareCommandSpecs()) this.addCommand(spec);
    // ⌘W 关闭编辑器 / ⌘S 保存 / 下一个·上一个编辑器(VSCode 同名命令)。
    for (const spec of editorCommandSpecs(detectPlatform())) this.addCommand(spec);
    // 更改文件编码 / 更改行尾序列(VSCode workbench.action.editor.changeEncoding / changeEOL;BDD: src/__tests__/editor-text-encoding/)
    for (const spec of encodingCommandSpecs()) this.addCommand(spec);
    // 缩进:使用空格 / Tab 缩进、从内容中检测、转换缩进(VSCode editor.action.indentUsingSpaces 等;BDD: src/__tests__/editor-indentation/)
    for (const spec of indentationCommandSpecs()) this.addCommand(spec);
    // 缩进设置变化 → 已打开文档按新设置重定;文档关闭 → 丢弃其缩进记录
    this.register({ dispose: installIndentationSync() });
    // 文本编辑命令(切换注释 / 移动行 / 选中行 / 折叠 …;BDD: src/__tests__/editor-text-commands/)
    for (const spec of editorTextCommandSpecs(detectPlatform())) this.addCommand(spec);
    // 后退 / 前进的导航记录(活动编辑器 / 路径变更 / 工作区根订阅;BDD: src/__tests__/editor-navigation-history/)
    this.register({ dispose: installNavigationHistory() });
    // 预览编辑器设置关闭 → 已有预览 tab 转常驻(BDD: src/__tests__/editor-preview-tab/)
    this.register({ dispose: installEditorPreviewSettingSync() });
  }
}
