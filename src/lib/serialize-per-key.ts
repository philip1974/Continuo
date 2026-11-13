// race(R21):按 key 串行化异步任务并返回结果(renderer 侧既有入口)。实现与 main 共用,
// 在跨进程单一来源 electron/shared/run-serial-per-key.ts。
export { runSerialPerKey } from '../../electron/shared/run-serial-per-key';
