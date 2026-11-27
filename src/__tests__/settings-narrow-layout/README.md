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
| `src/plugins/settings/SettingItemRow.tsx` | 行 `@container`;窄于 32rem 上下排列;标题行可换行;id 徽标可截断;控件不超出行宽 |
| `src/design/SegmentedControl.tsx` / `.css` | 轨道 `max-width: 100%` + 选项整项换行;选项文字不折行、放不下时省略号截断 |
| `src/plugins/settings/KeybindingsTabContent.tsx` | 命令标题 `min-w-0 flex-[1_1_6rem] truncate`;id 徽标先收缩、窄列表隐藏;键帽组可换行;按钮不收缩 |
| `src/plugins/settings/PluginsTabContent.tsx` | 贡献点表格行可换行(示例列不被挤成 0 宽);插件 id 徽标可截断 |

## 关键行为

### 设置面板(SettingsPanel)

- 根节点是名为 `settings` 的尺寸容器(`@container/settings`)
- 面板窄于 42rem:左侧导航宽度由固定 180px 改为自适应(`@max-2xl/settings:w-auto`),导航文字视觉隐藏
  (`sr-only`,仍是按钮可访问名),每项带 `title` 悬停提示;无图标的插件分类以首字(伪元素,不进可访问名)占位
- 宽面板下首字占位 `invisible`(不显示但保留图标位宽度):无图标插件页签文字与有图标的内置页签左对齐(此前 `hidden` 不占位,
  文字比内置页签左移一个图标位)
- 内容区窄面板时内边距 16px,宽面板(≥ 42rem)32px / 24px

### 设置项(SettingItemRow)

- 行根节点是尺寸容器(`@container`);主体默认上下排列(`flex-col`),行宽 ≥ 32rem 才左右并排(`@lg:flex-row`)
- 标题行 `flex-wrap`:标题与 id 徽标放不下时徽标换行;id 徽标 `min-w-0 max-w-full`,`<code>` `min-w-0 truncate` 省略号截断;
  `<code>` 带 `title`(完整设置 id,截断后悬停可看全文);标题列 `max-w-full`(上下排列时按内容取宽,须以行宽为上限,徽标截断才有参照)
- 控件区可换行(`flex-wrap`)且 `min-w-0 max-w-full`,分段控件 + 重置按钮放不下时换行而不溢出
- 分段控件(如主题「跟随系统 / 亮色 / 暗色」)窄于自身宽度时选项整项换到下一行,文字不被压成每字一行(400 宽窗口
  + 展开侧栏时设置内容区只剩约 80px);数值输入框 `w-24 min-w-0 max-w-full`(连同单位徽标的容器 `min-w-0 max-w-full`)、
  文本输入框 `w-48 max-w-full`,不超出行宽

### 快捷键页(KeybindingsTabContent)

- 命令标题 `min-w-0 flex-[1_1_6rem] truncate`(占剩余宽度,过长省略号,`title` 给全称):flex 基准 6rem、可收缩到 0,
  空间不足时与键帽组按基准比例一起收缩;不再用固定最小宽度(640 宽侧栏里改成 4 键组合 ⌥⇧⌘J 时,6rem 保底把重置按钮挤出列表)
- 命令 id 徽标 `min-w-0 max-w-[40%]`,`<code>` 截断;列表(`ul` 为 `@container`)窄于 28rem 时隐藏(`@max-md:hidden`)
- 键帽组 `min-w-0 flex-wrap`:放不下时折成两行
- 编辑 / 重置按钮 `shrink-0`,始终完整可见;列表 `ul` 不 `overflow-hidden`(行无底色无需裁圆角),贴边按钮的焦点环不被裁
- 顶部「N 条命令 · 未绑定用 ⌘⇧P …」提示行可换行;命令面板提示是整句模板(`keybindings.palette_hint`,`{keys}` 占位键帽组),
  键帽与前后文字的间距由各语言文案决定 —— ko「또는 ⇧⌘P로 …」助词紧贴键帽,不由 flex 间距插入空格
- 命令 id 徽标的 `<code>` 带 `title`(完整命令 id),窄宽截断后悬停可看全文

### 插件页(PluginsTabContent)

- 贡献点统计行 `flex-wrap`,示例列 `min-w-32 flex-1`:放不下时换到下一行,而不是被挤成 0 宽
- 内置 / 第三方插件 id 徽标可截断(`min-w-0`,`<code>` truncate,`title` 给完整 id);贡献点示例列截断时 `title` 给全文;第三方插件行窄宽时操作按钮换行
