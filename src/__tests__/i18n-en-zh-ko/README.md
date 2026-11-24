# topic 16 i18n en zh ko

本 topic 覆盖 Continuo 三语 i18n 的端到端行为契约:语言切换、settings 持久化、PTY `LANG` 环境保护、main menu 重建、popout 广播、错误码 message catalog、Settings 渲染时翻译、renderer bootstrap 顺序同步。

- `locale-store.spec.ts`: renderer settings store 与 `coApi.i18n` 的 set/get/onChange roundtrip。
- `t-fallback.spec.ts`: `translate()` 字典命中、fallback、缺 key warn 去重与插值。
- `error-codes-message-catalog.spec.ts`: 从 `ERROR_CODES` 枚举生成三语 `errors.*` catalog 全覆盖断言。
- `main-menu-rebuild.spec.ts`: main 进程语言切换后重建应用菜单,且不触碰 popout 菜单策略。
- `popout-locale-broadcast.spec.ts`: 多窗口语言变更广播到其他窗口。
- `pty-lang-env.spec.ts`: PTY 创建时保留合法用户 locale,修正缺失或不支持的 locale;按有效 locale(`LC_ALL` > `LC_CTYPE` > `LANG`)判断是否 UTF-8。
- `settings-service.spec.ts`: `settings.json` load/save、corrupt 备份与系统 locale 映射。
- `bootstrap-locale-sync.spec.ts`: renderer 启动先等待 main locale(及系统默认 locale),再 boot core plugins。
- 语言设置项的默认值 = main 系统默认 locale(`i18n:get-system-locale`,即首启默认):中文 / 韩文系统首启未改过不显示「已修改」,「恢复默认」回到系统语言(见 `49-polish-bugfixes/language-from-settings-no-fallback-clobber.spec.tsx`、`setting-item-row/setting-item-row.spec.tsx`)。
- `design-layer-no-keys.spec.ts`: `src/design` 共享层不直接依赖 i18n。
- `locale-concurrent.spec.ts`: 连续 `setLocale` 用 generation token 丢弃过期广播。
- `setting-locale-fields.spec.ts`: setting registry 的 title/description/label key 在渲染时翻译。
