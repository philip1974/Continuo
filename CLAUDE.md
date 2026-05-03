# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 最高优先级规则

- **设计和实现前一定要分析参考项目的设计和实现，除非必要尽可能不要全新创造。**
- **所有的问答都用中文。**
- 在没有充分读取已实现代码之前不要武断下结论。
- 如果需要开发新功能，首先要分析参考项目的实现；如果参考项目中没有就上网查找，实在没有再全新开发。
- 遵循极简原则，不要过度设计。

## BDD+TDD 驱动开发规则

- **任何新功能或行为变更，必须先写 BDD 规范，再写实现代码。**
- BDD 规范统一放在 `src/__tests__/<topic>/` 目录，每个主题包含 `README.md`（行为描述）和 `*.spec.ts`（可执行规范）。
- 新增、删除或重命名 BDD 文件后，必须运行 `pnpm bdd:index` 重新生成索引。
- 模块内部的单元测试遵循 TDD：先写失败测试，再写最小实现，最后重构。
- BDD 规范关注**外部行为语义**（用户/操作者可感知的稳定行为），TDD 测试关注**内部实现正确性**（函数、类、模块的逻辑）。
- BDD 与 TDD 的层级关系：
  - 根级 BDD（`src/__tests__/`）：跨模块的端到端行为契约
  - 包级测试（`packages/*/__tests__/`）：模块内部 TDD 单元/集成测试
- 开发流程：
  1. 明确要实现的行为 → 编写 BDD 规范（`*.spec.ts`）
  2. BDD 规范通不过 → 拆解到模块级 TDD 用例
  3. TDD 红-绿-重构循环 → 模块实现就绪
  4. 回到 BDD 规范验证端到端行为通过
- 禁止在没有对应测试的情况下提交新的业务逻辑。
- 使用 `test-driven-development` skill 辅助 TDD 流程，使用 `brainstorming` skill 辅助 BDD 规范设计。
- **反向 BDD（理解既有/AI 生成代码）也走同一目录与同一索引**：用 `/comprehend` skill 触发，AI 倒推 `src/__tests__/<topic>/`，再用 `pnpm bdd:mindmap <topic>` 把规范投影成思维导图，最后用 `comprehension-validator` agent 校验规范↔实装一致性。
