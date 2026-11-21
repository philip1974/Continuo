# theme-binding(SettingsValueStore ↔ ThemeProvider 桥)

行为契约:**`useThemeBinding()` 让 `general.theme` 设置项的值变化立即同步到 ThemeProvider:
store → setMode 单向。挂载时若 store 还没 key 但 ThemeProvider 已是非 default,推一次到 store。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/theme/binding.ts` | useThemeBinding hook |
| `src/theme/ThemeProvider.tsx` | mode/setMode 上下文 |
| `src/plugins/settings/values-store.ts` | setting 值 store |

## 关键行为

### store value 变 → setMode

- store 写入 `general.theme = 'light'`,binding 副作用调 `setMode('light')`,
  document.documentElement.classList 同步移除 `dark`

### store value === 当前 mode

- 不调 setMode(避免回环)

### 挂载迁移

- store 没 `general.theme` 且 ThemeProvider 当前 `mode !== 'dark'` →
  binding 主动调 `setValue('general.theme', mode)`,把 ThemeProvider 状态推到 store

### 非法值兜底

- store 写入 `'rainbow'`(非 light/dark/system) → binding 不调 setMode

### 默认 fallback

- store 没该 key → useSettingValue 返默认 `'dark'`,binding 不会触发 setMode(初始 mode 已是 dark)
