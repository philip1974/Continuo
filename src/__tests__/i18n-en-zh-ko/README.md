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
- `catalog-language-purity.spec.ts`: 文案语言纯净 —— zh / ko 不夹带 VSCode 本地化版会翻译的英文 UI 词(Settings / Explorer /
  Editor / Panel / Tab / tag / review / hotkey / terminal / workspace / token / Source·Edit 模式…;专有名词 Markdown / Git /
  MCP / Agent / shell 等与代码标识可保留),en 不含中文 / 韩文。
- `catalog-zh-ko-style.spec.ts`: zh / ko 术语与标点一致(对齐 VSCode 中文 / 韩文版)—— Quick Open 译为「快速打开」/「빠른 열기」,
  扩展统一叫「插件」/「플러그인」;zh 句内逗号 / 分号 / 问号 / 叹号 / 冒号用全角,含中文或紧跟汉字的括号用全角「（）」,引号统一「」;
  反引号代码段与占位符之间(`{src}: {message}`)保留半角。快捷键录制弹窗的命令行 / 提示行是整句模板(`{command}` /
  `{enter}` 等占位由组件换成命令名 / 键帽),同样受此规则约束;仅终端「(已退出)」后缀仍由代码拼接、暂豁免。
- `catalog-en-style.spec.ts`: en 引号一致(对齐 VSCode 英文版)—— 引用文件名 / 命令名 / 搜索词一律弯引号 “…”,不出现直引号包裹的占位符
  (`'{x}'` / `"{x}"`)、直双引号或当引号用的直单引号;词内撇号(Don't)与反引号代码段内保留原样;弯引号成对。
- `runtime-label-colon.spec.ts`: 组件运行期拼接的「标签：原因」(自动保存失败 / 打开失败 / 贡献 action 失败 / 从 Git 安装失败附 git
  报错行 / 授权弹窗「模式：…」)走 catalog 插值 `common.label_detail`,zh 全角「：」、en / ko 半角「: 」;守卫 renderer 源码不再把
  翻译文案与半角冒号直接拼接。
- `html-lang.spec.ts`: `<html lang>` 随界面语言(en / zh-CN / ko)写入 —— 读屏按它选发音;`theme.css` 的 `:lang(ko)`
  让韩文按词断行(`word-break: keep-all`)。
