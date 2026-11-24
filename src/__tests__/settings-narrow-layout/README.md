# 设置页窄宽布局(settings-narrow-layout)

行为契约:**设置面板被挤窄(如 800 宽窗口、旁边开着资源管理器)时,各设置页内容仍可读、控件完整可见,
不出现「描述一行一个词」「标题被截成 Languag / 中文标题竖排」「徽标 / 键帽 / 表格列被裁掉」。**
参考 VSCode 设置编辑器:窄宽时收起左侧目录(TOC),设置项本身上下排列(标题 / 描述在上,控件在下)。

布局按**容器宽度**(Tailwind v4 容器查询 `@container`)而非视口宽度切换 —— 设置面板宽度取决于 dock 分栏,
与窗口宽度无直接关系。jsdom 不计算容器查询,规范断言对应 class 存在,实际效果由截图人工核对。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/SettingsPanel.tsx` | 面板根 `@container/settings`;窄于 42rem 导航收成图标栏、内容区缩小内边距 |
| `src/plugins/settings/SettingItemRow.tsx` | 行 `@container`;窄于 32rem 上下排列;标题行可换行;id 徽标可截断 |
| `src/plugins/settings/KeybindingsTabContent.tsx` | 命令标题 `min-w-0 flex-1 truncate`;id 徽标可收缩、窄列表隐藏;键帽 / 按钮不收缩 |
| `src/plugins/settings/PluginsTabContent.tsx` | 贡献点表格行可换行(示例列不被挤成 0 宽);插件 id 徽标可截断 |

## 关键行为

### 设置面板(SettingsPanel)

- 根节点是名为 `settings` 的尺寸容器(`@container/settings`)
- 面板窄于 42rem:左侧导航宽度由固定 180px 改为自适应(`@max-2xl/settings:w-auto`),导航文字视觉隐藏
  (`sr-only`,仍是按钮可访问名),每项带 `title` 悬停提示;无图标的插件分类以首字(伪元素,不进可访问名)占位
- 内容区窄面板时内边距 16px,宽面板(≥ 42rem)32px / 24px

### 设置项(SettingItemRow)

- 行根节点是尺寸容器(`@container`);主体默认上下排列(`flex-col`),行宽 ≥ 32rem 才左右并排(`@lg:flex-row`)
- 标题行 `flex-wrap`:标题与 id 徽标放不下时徽标换行;id 徽标 `min-w-0 max-w-full`,`<code>` 省略号截断
- 控件区可换行(`flex-wrap`),分段控件 + 重置按钮放不下时换行而不溢出

### 快捷键页(KeybindingsTabContent)

- 命令标题 `min-w-0 flex-1 truncate`(占剩余宽度,过长省略号,`title` 给全称)
- 命令 id 徽标 `min-w-0 max-w-[40%]`,`<code>` 截断;列表(`ul` 为 `@container`)窄于 28rem 时隐藏(`@max-md:hidden`)
- 键帽、编辑 / 重置按钮不收缩,始终完整可见
- 顶部「N 条命令 · 未绑定用 ⌘⇧P …」提示行可换行

### 插件页(PluginsTabContent)

- 贡献点统计行 `flex-wrap`,示例列 `min-w-32 flex-1`:放不下时换到下一行,而不是被挤成 0 宽
- 内置 / 第三方插件 id 徽标可截断(`min-w-0`,`<code>` truncate);第三方插件行窄宽时操作按钮换行
