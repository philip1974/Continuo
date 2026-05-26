# terminal-osc7 - OSC 7 cwd parser migration to @continuo-terminal/react-terminal

topic-26 sibling-migration:Continuo `useTerminal.ts:309-322` inline OSC 7 cwd parsing moved to `@continuo-terminal/react-terminal` package(parser + binder).

## Specs

- `byte-identical.spec.ts` - T11:cleanup dispose sanity(simple wrapper smoke)
- `use-terminal-wiring.spec.ts` - T13a/T13b/T13c:**real useTerminal wiring**(vi.hoisted mock `registerOsc7Cwd`, capture onCwd to verify coApi.terminal.updateCwd call + unmount dispose)

byte-identical evidence chain = sibling TDD T1-T8c(parser + binder equivalence classes)+ Continuo T11/T13(real useTerminal wiring + structural mock).
