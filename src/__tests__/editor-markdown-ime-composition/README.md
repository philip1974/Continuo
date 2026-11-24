# editor-markdown-ime-composition

行为契约:**Markdown Edit(Milkdown)里,输入法组合(中文拼音 / 韩文等)期间按下的 Enter / Esc / 方向键属于输入法
(上屏、撤销拼音、选候选),链接气泡输入框与斜杠菜单都不处理;组合结束后这些键照常生效。** 组合判定与 VSCode 等一致:
`KeyboardEvent.isComposing` 为真或 `keyCode === 229`(两者任一即视为组合中)。

## 背景

- 链接气泡(`@milkdown/components` link-tooltip 的编辑输入框)keydown 只看 `e.key`:拼音组合中按 Enter 上屏字母 →
  未上屏的拼音被当作地址确认保存并关闭气泡;Esc 撤销拼音 → 取消整次链接编辑。
- 斜杠菜单(`@milkdown/crepe` BlockEdit)在 **window 捕获阶段**处理 Enter / Esc / ↑↓←→,同样不判组合。zh / ko 界面下
  菜单项已本地化、过滤只匹配 label,用户必须在 `/` 后用输入法打字:组合中 Esc 关菜单、Enter 执行高亮项、选候选的方向键
  同时移动菜单高亮。

## 修复

`scripts/vite-milkdown-link-href.ts` 的构建期补丁(与链接地址补丁同一插件;renderer 构建走 vite transform,dev 预打包走
esbuild 插件,vitest 的 `milkdown-patched` project inline `@milkdown/*` 后同样经过 transform):

- link-tooltip 编辑输入框 `onKeydown`:`e.stopPropagation();` 之后插入组合判断直接返回(仍阻止冒泡给编辑器)。
- Crepe 斜杠菜单 `onKeydown`:函数开头插入组合判断直接返回。`@milkdown/crepe` 主入口(MilkdownEditor 使用,内联了
  block-edit)与子路径入口 `feature/block-edit` 两份产物都修补。

锚点各须恰好命中一次,否则构建报错(升级 Milkdown 后先看上游是否已修)。

## 未做:斜杠菜单英文关键词

Crepe 7.23 的斜杠菜单过滤只比较 `item.label`(`getGroups` 内 `label.toLowerCase().includes(filter)`),BlockEdit
配置没有 keywords / 搜索字段,无法经 featureConfigs 给条目加英文别名;故 `/code`、`/h1` 在中文界面仍不匹配,不做。

## Specs

| File | 覆盖 |
|---|---|
| `ime-composition.spec.ts` | 真实 Crepe(jsdom):链接气泡组合中 Enter(`isComposing` / `keyCode 229`)不保存、不关闭,结束后 Enter 保存;组合中 Esc 不取消、结束后 Esc 取消;斜杠菜单组合中 Esc 不关闭 / Enter 不执行高亮项 / 方向键不移动高亮,结束后照常;补丁锚点、上游未修、对不上报错、三处注册 |
