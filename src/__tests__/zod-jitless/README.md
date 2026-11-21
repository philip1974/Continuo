# zod-jitless

行为契约:**renderer 在构造任何 zod 4 object schema 之前开启 `jitless`,不触发 CSP `unsafe-eval` 违规**。

zod 4 首次构造 `z.object` 时会用 `new Function` 探测能否 JIT(已构造的 schema 保留当时的设置);renderer 的 CSP(`script-src 'self' blob:`)
禁止 eval,探测会产生一次 `securitypolicyviolation`。`src/lib/zod-jitless.ts` 设置 `config({ jitless: true })`,
且必须是 `main-app.ts` 的第一个 import(模块按 import 顺序求值,先于其它模块顶层的 schema 构造)。

- 导入 `@/lib/zod-jitless` 后 `z.config().jitless === true`。
- `src/main-app.ts` 的第一个 import 是 `./lib/zod-jitless`。
