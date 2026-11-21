// 暴露给第三方插件的 zod(插件运行时的 co.z)。应用自身用 zod 4,但插件按 zod 3 API 编写,
// 故取 zod 4 包内的 `zod/v3` 兼容入口,保持插件运行时接口不变。
export { z as pluginZod } from 'zod/v3';
