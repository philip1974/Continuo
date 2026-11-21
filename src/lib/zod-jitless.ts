// renderer 的 CSP 禁止 eval;zod 4 首次构造 z.object 时会用 new Function 探测能否 JIT,触发一次 CSP 违规,
// 且已构造的 schema 保留当时的 JIT 设置。关闭 JIT 免去探测:须是 main-app.ts 的第一个 import,
// 先于任何 zod 4 object schema 的构造(含各模块顶层的 schema 常量)。
import { config } from 'zod';

config({ jitless: true });
