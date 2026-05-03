# BDD 规范根目录

每个子目录是一个**主题**,包含:

- `README.md` — 行为描述(给人读)
- `*.spec.ts` — 可执行规范(给 vitest 跑)

新增/删除/重命名主题后运行 `pnpm bdd:index`,会刷新 [`INDEX.md`](./INDEX.md)。

## 与 TDD 的边界

- BDD 关注**外部可感知行为**(用户 / 操作者视角),稳定不易变。
- 模块内 TDD 单元测试放在 `<module>/__tests__/` 内,关注实现正确性。
