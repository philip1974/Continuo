# 48-main-inject-continuo-meta

main 经 `webPreferences.additionalArguments` 给 sandbox renderer 注入它自己拿不到的本机信息,preload 解析后经
`coApi.system` 同步暴露。最初(topic 48)这条通道为 plugin-isolation spike 注入 `--continuo-packaged`;spike 删除后
该参数与 `window.__continuoMeta` 一并删除,通道只留下列两项。

Observable behavior:

- `webPreferences` 由同一工厂 `buildCommonWebPreferences` 构造,每个窗口拿到独立的对象与 `additionalArguments` 数组。
- 本机 hostname:`--continuo-hostname=<os.hostname()>`,preload 解析(缺失 / 空 → `null`)并暴露为
  `coApi.system.hostname`,供终端 OSC7 parser 的 `acceptedHosts` 使用。
- Windows build 号(仅 win32 注入):`--continuo-windows-build=<n>`,暴露为 `coApi.system.windowsBuild`
  (见 `terminal-windows-pty`)。
- 不再注入 `--continuo-packaged`,preload 不再暴露 `window.__continuoMeta`。
