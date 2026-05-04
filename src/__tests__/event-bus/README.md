# event-bus(LM 自定义事件总线 + Plugin.registerEvent)

行为契约:**LM 内核 / 插件互相通信的命名事件总线**。Plugin 通过
`this.registerEvent({ name, fn })` 订阅,自动 dispose。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/EventBus.ts` | EventBus 类:on / off / emit |
| `src/plugins/Plugin.ts`(扩展) | 新增 `registerEvent` 代理 |

## 关键行为

### 类型化事件名(可扩展)

- `LMEventMap` 是 `Record<string, unknown>`,各事件名字符串,payload 任意
- 内核不预先穷举事件,Plugin 自由定义(命名建议 `<scope>.<verb>`,如 `editor.file-saved`)

### EventBus

- `on(name, listener)` 返回 Disposable;dispose 移除监听
- `emit(name, payload)` 同步广播全部 listener,单 listener 抛错不影响其他(warn)
- `off(name, listener)` 显式移除(register 已自动 dispose,这里给非 plugin 场景用)
- `clear(name?)` 测试 / 重置用

### Plugin 集成

- `registerEvent({ name, fn })` 内部 `this.app.events.on(name, fn)` → `this.register(d)`
- _deactivate 自动取消订阅
