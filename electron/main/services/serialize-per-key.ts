// 主进程「同 key 串行 + 要结果」并发锁的入口(withPluginMutationLock、PTY resize 链等)。实现与
// renderer 共用,在 electron/shared/run-serial-per-key.ts(race R15/R17/R21 提炼,R100/R101 排空回收)。
// 原 fire-and-forget 变体 serializePerKey 已无生产调用方(resize 改为要结果的 runSerialPerKey),删除。
export { runSerialPerKey } from '../../shared/run-serial-per-key';
