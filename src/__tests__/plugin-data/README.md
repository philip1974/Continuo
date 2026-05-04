# plugin-data(loadData / saveData)

行为契约:**每个插件有独立的 JSON 数据文件**(生产 `userData/plugins/<id>/data.json`),
Plugin 父类通过 `loadData<T>()` / `saveData(o)` 异步读写。**存储后端注入**
(LMApp.dataStore),测试用 in-memory mock,生产用 IPC。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/PluginDataStore.ts` | DataStore 接口 + InMemoryDataStore 默认实现 |
| `src/plugins/Plugin.ts`(扩展) | `loadData<T>()` / `saveData(o)` |

## 关键行为

### DataStore 接口

```ts
interface PluginDataStore {
  read(pluginId: string): Promise<unknown | null>;
  write(pluginId: string, data: unknown): Promise<void>;
}
```

LMApp 加 `dataStore: PluginDataStore` 字段。

### loadData<T>()

- 调 `app.dataStore.read(this.manifest.id)`
- 返回 unknown,调用方负责 cast(`<T>` 仅泛型断言)
- 文件不存在 / read 抛错 → 返 null(不抛)

### saveData(data)

- 调 `app.dataStore.write(this.manifest.id, data)`
- 抛错向上传(由插件决定如何处理)
- data 必须 JSON-serializable(由 store 实现负责验证 / 抛错)

### InMemoryDataStore

- 默认实现,Map<id, value>;测试 / 单元用
- 生产替换为 IPC-backed 实现(M-Plugin v3 接 `userData/plugins/<id>/data.json`)
