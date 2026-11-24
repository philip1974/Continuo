// 设置值(values-store)的 localStorage 键。独立成无依赖模块:renderer 入口(main.tsx)首帧前同步读主题设置时
// 引用它,不把 zustand / 设置 store 拉进入口 chunk。
export const SETTINGS_VALUES_STORAGE_KEY = 'continuo.settings.values';
