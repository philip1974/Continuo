# 编辑器状态跨重启 / 切 tab 保持(VSCode 对齐)

VSCode 把每个打开的编辑器的视图状态(选区、滚动)存进工作区存储,重启后按文件恢复;图片预览(media-preview 的
webview)把缩放比例与偏移存在 webview state,切走再切回、重启后都还原。Markdown 预览在 VSCode 是独立编辑器,随会话恢复。
Continuo 对应:

| 状态 | 切 tab | 跨重启 |
|---|---|---|
| CodeMirror 选区 / 滚动 | 已有(`editor-view-state`) | 本主题:`editor.viewStates[].selection / topLine` |
| Milkdown(Markdown 编辑 / 预览)滚动 | 已有 | 本主题:`editor.viewStates[].scrollTop`(内存缓存的原形态) |
| 图片预览缩放与滚动 | 本主题 | 本主题:`editor.viewStates[].image` |
| Markdown 视图模式(全局,编辑 / 源码 / 预览) | 已有(全局) | 本主题:`editor.mode`(只在非默认 source 时写) |

> Markdown 模式在 Continuo 是窗口内全局的一个开关(所有 Markdown tab 共用),因此按窗口段持久化一个值,而不是按文件。

## 磁盘契约(`electron/shared/explorer-persistence-schema.ts` 的 EditorSessionSchema)

```ts
editor?: {
  openFilePaths: string[];
  activePath: string | null;
  mode?: 'edit' | 'source' | 'preview';
  viewStates?: Array<{               // ≤ EDITOR_VIEW_STATES_MAX(256)条,只含打开中的 file tab
    path: string;
    group?: string;                  // 编辑器组 id;多于一个组时按组各一条(见 editor-view-state-groups)
    selection?: { anchor: int ≥ 0; head: int ≥ 0 };
    topLine?: int ≥ 1;
    folds?: Array<{ from: int ≥ 0; to: int ≥ 0 }>;  // ≤ 500 条折叠区域(见 editor-view-state-groups)
    scrollTop?: number ≥ 0;
    image?: { scale: 'fit' | 0.1–20; scrollLeft: ≥ 0; scrollTop: ≥ 0 };
  }>;
}
```

- 两个字段都是 optional:旧快照照常读;无状态 / 默认模式时不写(旧形态不变)。
- 读(`ExplorerSchemaV3`)与写(`ExplorerWritableSnapshotSchema`)共用同一个 EditorSessionSchema;条目 strict、数值有上下限。
- 写端(`collectEditorViewStates`)守同一上限:按组顺序、组内 tab 顺序至多 256 条,数值收进 schema 范围、非有限值丢弃 —— 运行时状态不会让
  `explorer:write` 拒整份快照。

## 行为(`editor-state-restart.spec.tsx`)

### 写快照
- CodeMirror:仍挂着的视图取当前选区与顶部可见行(由 `scrollSnapshot()` 得出,不触发布局测量);已卸载的取本会话缓存;
  本会话未挂载过的取上次会话留下的摘要(不丢)
- Milkdown 滚动、图片缩放取缓存;插件打开的 tab 不写(与 openFilePaths 同口径)
- `mode` 非 source 时写;切换模式调度一次持久化写
- 光标 / 滚动 / 缩放本身不调度写(太频繁),只递增「视图状态代际」;切 tab(activeTabId 变)的常规写会带上,关窗 / 退出的
  立即落盘在代际变了时重取快照写入(代际与已落盘的相同 → 不重建快照,保持 clean flush 零开销)

### 恢复
- `hydrateStores` 先回填 `mode`,恢复出的 tab 直接按该模式挂载
- `hydrateEditorTabs` 对读盘成功的 tab 在 `openTab` 前回填视图状态(读盘失败的不留状态;读盘期间用户已自己打开的不覆盖)
- CodeMirror 只在该 tab 本会话首次挂载时用快照:选区收进当前文档范围,快照的首行滚到视口顶(外部改短的文件不越界)
- 之后切走再切回按本会话的状态(`editor-view-state`)

### 图片预览
- 比例与滚动位置按 tab 记(缩放 / 滚动时),切走再切回恢复;各 tab 互不影响;未缩放过的图片不留状态
- 随会话快照跨重启恢复

## 端到端
- `tests/e2e/editor-state-restart.spec.ts`:重启后光标与滚动恢复、Markdown 模式恢复、图片缩放切 tab 保留
