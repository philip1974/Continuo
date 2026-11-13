// manifest.json 解析 + SemVer 比对的 renderer 侧既有入口。实现是 main / renderer 共用的跨进程契约,
// 在 electron/shared/plugin-manifest.ts。
export * from '../../electron/shared/plugin-manifest';
