# plugin-manifest(manifest.json 解析与版本比对)

行为契约:**插件目录的 `manifest.json` 解析为 `PluginManifest` 类型化对象**,
用 zod 校验 + 自定义 semver 比对。失败返回 `{ ok: false, code, message }`,
不抛错(由 PluginManager 决定跳过 / 提示用户)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/manifest.ts` | `parseManifest(jsonText)` + `isVersionCompatible(app, min)` |

## 关键行为

### parseManifest

- 入参非合法 JSON → `{ ok: false, code: 'INVALID_JSON' }`
- JSON 合法但 zod 校验失败 → `{ ok: false, code: 'SCHEMA_ERROR', message }`
- 全部 OK → `{ ok: true, data }`,`main` 缺失补默认 `'main.js'`
- 不抛错(防 PluginManager 因单插件挂掉)

### Schema 必填

- `id`(反 DNS 命名,允许 `a-z 0-9 . _ -`)
- `name`(非空字符串)
- `version`(SemVer `MAJOR.MINOR.PATCH` 主体,允许 `-prerelease`)

### Schema 可选

- `main` 默认 `'main.js'`
- `description / author / authorUrl(URL)` 自由文本
- `minLMVersion`(SemVer,与 LM 版本比对)
- `isDesktopOnly`(默认 undefined,LM 当前只有桌面,先不强制)

### isVersionCompatible(appVersion, pluginMin)

- 解析两个 SemVer,只看 major.minor.patch 三段
- 返回 `app >= pluginMin`
- 任一非合法版本 → false(保守:拒载)
- 边界相等 → true
