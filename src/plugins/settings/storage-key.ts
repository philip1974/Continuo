// 设置值(values-store)旧版 localStorage 键:设置值现存在主进程 userData/user-settings.json,这个键只作首次启动新版本时的
// 一次性迁移来源(见 storage/user-settings-record.ts)。独立成无依赖模块:renderer 入口(main.tsx)首帧前同步读主题设置时
// 引用它,不把 zustand / 设置 store 拉进入口 chunk。
export const SETTINGS_VALUES_STORAGE_KEY = 'continuo.settings.values';
