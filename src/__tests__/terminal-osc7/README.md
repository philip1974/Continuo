# terminal-osc7 - OSC 7 cwd parser migration to @continuo-terminal/react-terminal

topic-26 sibling-migration:Continuo `useTerminal.ts:309-322` inline OSC 7 cwd parsing moved to `@continuo-terminal/react-terminal` package(parser + binder).

## Specs

- `byte-identical.spec.ts` - T11:cleanup dispose sanity(simple wrapper smoke)
- `use-terminal-wiring.spec.ts` - T13a/T13b/T13c:**real useTerminal wiring**(vi.hoisted mock `registerOsc7Cwd`, capture onCwd to verify coApi.terminal.updateCwd call + unmount dispose)

- `use-terminal-wiring.spec.ts` - T13a/T13d/T13e:**acceptedHosts** = `['', 'localhost', <本机 hostname>]`。shell 集成(bash/fish)与 oh-my-zsh 等发 `file://<真实 hostname>$PWD`,parser 默认只收空 host / localhost 会静默丢弃 cwd 更新。hostname 由 main 经 `additionalArguments`(`--continuo-hostname=`,同 topic-48 通道)注入,preload 暴露为 `coApi.system.hostname`;不可得 → 仅 `['', 'localhost']`;他机 hostname 仍拒。

- `use-terminal-wiring.spec.ts` - T13f:**updateCwd 去重 + 尾随合并**(`CWD_REPORT_DEBOUNCE_MS`=50ms,窗口随新 OSC7 顺延)。每个 prompt 都发 OSC7,readHistory 回放会重放历史里每个 OSC7:窗口内只发最终值;与上次已发送值相同不发;卸载时丢弃待发值。

byte-identical evidence chain = sibling TDD T1-T8c(parser + binder equivalence classes)+ Continuo T11/T13(real useTerminal wiring + structural mock).
