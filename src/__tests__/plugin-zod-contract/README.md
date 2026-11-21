# plugin-zod-contract

行为契约:**插件经 `globalThis.co.z` 拿到的 zod 保持 zod 3 API**。

应用自身已升级到 zod 4,但 `co.z` 是第三方插件的运行时接口(写 MCP tool `inputSchema` 等),
插件按 zod 3 编写。因此 `co.z` 取自 zod 4 包内的 `zod/v3` 兼容入口,而非应用使用的 zod 4。

- `z.object({ x: z.unknown() })` 缺 `x` 也通过(zod 3 语义;zod 4 视为必填)。
- 校验失败的 `ZodError` 有 `.errors` 数组。
- `required_error` 自定义文案生效。
