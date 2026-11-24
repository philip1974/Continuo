# bdd-index-integrity

`src/__tests__/INDEX.md`(由 `pnpm bdd:index` 生成)与目录一致:每个含 spec 的主题、其下(含子目录)的每个 spec 都被索引。
`bdd-index` 递归列出主题内的 spec —— 此前只扫第一层,把 spec 放在 `shape/` / `integration/` 子目录的 sdk-contract 整个
主题从索引消失。新增 spec 后漏跑 `pnpm bdd:index` 也由本规范发现。
