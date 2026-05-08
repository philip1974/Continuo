# 模块冻结 Checklist · 模板

> 复制本文件到 `freeze-<module>.md`,逐项填写。冻结后**任何变更必须先在本文档追加
> ADR(Architecture Decision Record)**,记录改动理由 + 影响面 + 回归命令。

## 1. 模块身份

- **模块名**:`<module-id>`
- **覆盖代码**:`src/<path>/...` / `electron/<path>/...`(列主要源码目录)
- **冻结日期**:`YYYY-MM-DD`
- **冻结发起人**:`<git-user>`

## 2. 稳定行为契约

> 列出**用户/调用方可感知的、本模块承诺不变**的行为。每一条都应该对应一个 BDD topic
> 或 contract spec。

- [ ] 行为 1:...(对应 `src/__tests__/<topic>/<spec>.spec.ts`)
- [ ] 行为 2:...
- [ ] ...

## 3. BDD topics(分层标注)

- **contract**(外部契约,改动需 ADR):
  - `<topic-1>` ([\[contract\]](../../src/__tests__/<topic-1>/README.md))
- **integration**(纵向链路):
  - `<topic-2>`
- **unit**(内部逻辑):
  - `<topic-3>`

## 4. 必跑命令(回归矩阵)

> 改动本模块或其依赖项后,**至少**跑以下命令,全绿才能合并。

```bash
# 类型 + 静态
pnpm typecheck
pnpm lint

# 该模块的 BDD spec(用 vitest filter)
pnpm vitest run src/__tests__/<topic-1> src/__tests__/<topic-2>

# 上一层 contract / integration 项目
pnpm test:contract   # 如果模块属 contract 范畴
pnpm test:integration

# 设计层(如果模块属 design system)
pnpm sync:design:check
```

## 5. 回归用例(关键路径手测)

> 模块发布前在本机或 CI artifact 上至少跑通以下手测路径。

- [ ] 路径 1:...
- [ ] 路径 2:...

## 6. ADR 历史

> 冻结后每次变更追加一条。

### ADR-001 · `YYYY-MM-DD` · `<author>`

- **变更**:...
- **理由**:...
- **影响面**:...
- **回归命令**:...
- **结果**:✅ 通过 / ⚠ 已知风险:...
