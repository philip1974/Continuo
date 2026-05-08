# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 最高优先级规则

* **设计和实现前一定要分析参考项目的设计和实现，除非必要尽可能不要全新创造。**

* **所有的问答都用中文。**

* 在没有充分读取已实现代码之前不要武断下结论。

* 如果需要开发新功能，首先要分析参考项目的实现；如果参考项目中没有就上网查找，实在没有再全新开发。

* 遵循极简原则，不要过度设计。

## BDD+TDD 驱动开发规则

* **任何新功能或行为变更，必须先写 BDD 规范，再写实现代码。**

* BDD 规范统一放在 `src/__tests__/<topic>/` 目录，每个主题包含 `README.md`（行为描述）和 `*.spec.ts`（可执行规范）。

* 新增、删除或重命名 BDD 文件后，必须运行 `pnpm bdd:index` 重新生成索引。

* 模块内部的单元测试遵循 TDD：先写失败测试，再写最小实现，最后重构。

* BDD 规范关注**外部行为语义**（用户/操作者可感知的稳定行为），TDD 测试关注**内部实现正确性**（函数、类、模块的逻辑）。

* BDD 与 TDD 的层级关系：

  * 根级 BDD（`src/__tests__/`）：跨模块的端到端行为契约

  * 包级测试（`packages/*/__tests__/`）：模块内部 TDD 单元/集成测试

* 开发流程：

  1. 明确要实现的行为 → 编写 BDD 规范（`*.spec.ts`）
  2. BDD 规范通不过 → 拆解到模块级 TDD 用例
  3. TDD 红-绿-重构循环 → 模块实现就绪
  4. 回到 BDD 规范验证端到端行为通过

* 禁止在没有对应测试的情况下提交新的业务逻辑。

* 使用 `test-driven-development` skill 辅助 TDD 流程，使用 `brainstorming` skill 辅助 BDD 规范设计。

* **反向 BDD（理解既有/AI 生成代码）也走同一目录与同一索引**：用 `/comprehend` skill 触发，AI 倒推 `src/__tests__/<topic>/`，再用 `pnpm bdd:mindmap <topic>` 把规范投影成思维导图，最后用 `comprehension-validator` agent 校验规范↔实装一致性。

## 设计系统约束

> Continuo 与 Nous 共用 `@nous/shell-ui/design`（本地副本在 `src/design/`），下列规则保护这一共享层不退化。

### 颜色

* **禁止**在组件 className 写 `bg-neutral-* / text-neutral-* / border-neutral-* / ring-sky-* / bg-sky-* / bg-[#hex]` 等任何 Tailwind 默认色或字面 hex。

* **必须**用语义 token：`bg-canvas / bg-panel / bg-panel-soft / bg-hover / text-fg / text-fg-muted / text-fg-dim / border-line / accent`（解析自 `--md-*`，由 `src/styles/theme.css` 的 `@theme inline` 映射）。

* 新增颜色场景 → 改 `theme.css` 加 `--md-*` 槽位 → 在 `@theme inline` 暴露成 `--color-*` utility，**不要**在组件局部硬编码。

### 组件

* **禁止**新写 `<button>`、`<input>`、`<textarea>` 等基础控件的 className 实现。优先用 `@/design`：`Button / IconButton / NavRailButton / MenuItem / TabNav / SegmentedControl / Modal / Card / Spinner / Badge / Tabs / Input / Textarea / Separator / ScrollArea`。

* 真要 native（如超紧凑 28px 行高的工具栏文本按钮），写明注释解释为何 design 不适用，并复用语义 token。

* 对话框 / 弹层 → 用 design `Modal`，不直接用 `@radix-ui/react-dialog`。

### 共享层修改

* `src/design/` 是 Nous shell-ui 的 Continuo 副本。**默认不改**。如需 Continuo 微调（IDE 视觉收圆角、降字重等），在文件顶部加注释 `// Continuo-local 微调:...,Nous 上游保持 ...`，commit 信息也说明。

* Continuo-local 扩展 variant（如 `Button outlined`、`IconButton`）允许,但要协调把通用部分推回 Nous（写任务卡 + 记录于 `doc/`）。

* `src/styles/nous-tokens.css` 是 Nous 的纯复制,**绝不**修改 — Continuo 调色板覆盖写在 `theme.css` 的 `.dark` 块。

### 主题切换

* 全应用通过 `<html class="dark">` + `ThemeProvider` 切换。代码不要假定永远是暗色 — 新色板必须在 `:root` (light) 与 `.dark` 都给值。Continuo 当前默认 dark,light 是占位。

