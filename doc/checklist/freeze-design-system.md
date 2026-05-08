# 模块冻结 Checklist · design-system

> 冻结后**任何变更必须先在本文档追加 ADR**,记录改动理由 + 影响面 + 回归命令。
> 单一真相源是 Nous `packages/shells/shell-ui/src/design/`,LM-local 微调走
> `scripts/sync-design.mjs` 的 `mode: 'fork'` + reason 声明。

## 1. 模块身份

- **模块名**:`design-system`
- **覆盖代码**:
  - `src/design/**`(13 个组件:Badge / Button / Card / IconButton / Input /
    MenuItem / Modal / NavRailButton / ScrollArea / SegmentedControl / Separator /
    Spinner / TabNav / Tabs / Textarea)
  - `src/styles/nous-tokens.css`(纯复制,**绝不**修改)
  - `src/styles/theme.css`(`:root` light + `.dark` 槽位映射 + `@theme inline`)
  - `scripts/sync-design.mjs` + `scripts/sync-design:check`
- **冻结日期**:2026-05-08
- **冻结发起人**:limu7475@gmail.com

## 2. 稳定行为契约

- [ ] 颜色语义 token(`bg-canvas / bg-panel / bg-panel-soft / bg-hover / text-fg /
      text-fg-muted / text-fg-dim / border-line / accent`)永不直接挂硬编码 hex
- [ ] 组件层(Button / IconButton / Modal / Tabs / TabNav 等)永不被 `<button>`
      `<input>` `<textarea>` 裸 className 实现绕过
- [ ] 弹层一律走 `Modal`,**不**直接用 `@radix-ui/react-dialog`
- [ ] Modal `size` prop(sm/md/lg)是 LM-local API,sync-design 已 fork 声明,
      Nous 上游变化不会覆盖
- [ ] `<html class="dark">` + `ThemeProvider` 切换时 light/dark 都有色板

## 3. BDD topics

- **contract**(外部契约,改动需 ADR):
  - `decor-contracts` `[contract]`
- **unit**(内部逻辑):
  - `design-system`
  - `design-system-modal`
  - `design-system-tabs`
  - `decor-shell`
  - `theme-system`(theme token 切换行为)
  - `theme-binding`(class 切换 hook 行为)

## 4. 必跑命令

```bash
# 设计层不漂移
pnpm sync:design:check

# 该模块涉及的 BDD spec
pnpm vitest run \
  src/__tests__/design-system \
  src/__tests__/design-system-modal \
  src/__tests__/design-system-tabs \
  src/__tests__/decor-shell \
  src/__tests__/decor-contracts \
  src/__tests__/theme-binding

# 全局保护层
pnpm typecheck
pnpm lint
pnpm test:contract
```

## 5. 回归用例

- [ ] `pnpm dev` 启动后切换 light / dark 主题,所有组件颜色不破图(尤其
      Modal 背景、Button 文字、Card tone)
- [ ] 打开 settings 面板各类控件(toggle / SegmentedControl / Input / Tabs)
      渲染正常,焦点环可见
- [ ] 打开 command palette / quick open / settings 全部 Modal,Esc 与点遮罩
      关闭,内部 Tab 焦点 trap 正常

## 6. ADR 历史

_(冻结起算,变更时追加)_
