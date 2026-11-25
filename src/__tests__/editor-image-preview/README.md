# 编辑器图片预览与 Markdown 相对路径图片(对齐 VSCode media-preview / markdown 预览)

行为契约:**打开 png / jpg / jpeg / jpe / gif / webp / ico / bmp / avif 文件时,编辑区显示只读图片预览,不再读成文本报
「文件是二进制或非 UTF-8」;Markdown 编辑 / 预览模式里 `![alt](./q.png)` 这类相对路径图片按文档所在目录解析并显示,
源文本不被改写。** 图片数据只经主进程受控通道读取(不放开 `file:`),CSP 不变。

## VSCode 参照

- 内置扩展 media-preview 的 `imagePreview.previewEditor`(selector `*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif}`):只读,
  图片居中、大于编辑区时按比例缩小适应(不放大小图),透明像素下衬棋盘格;状态栏显示尺寸(`宽x高`)与文件大小;
  文件在磁盘上变化后重新加载;加载失败显示「加载图片时出错」。`.svg` 不在其中 —— VSCode 把 svg 当文本打开,Continuo 同(保持现状)。
- markdown-language-features 预览:相对图片按文档目录解析(`asWebviewUri`),只能加载 `localResourceRoots`(工作区)内的文件;
  严格安全级别 CSP `img-src 'self' https: data:` —— 允许 https 远程图片,不允许 http。

## 行为

### 图片文件(只读视图)

- 打开路径(Explorer / Quick Open / 链接 / 会话恢复 / 外部同步)按扩展名路由:图片不经 `fs:read-file` 文本读取,tab
  内容只是磁盘 `stat` 指纹(`mtimeMs:size:ino`),用于外部修改检测;编辑区渲染只读 `ImageViewer`。
- 图片数据经 `fs:read-image`(主进程 `readImage`)读取为 data URL:扩展名必须是上述格式(否则 FS_DENIED),
  单 fd 有界读,超过 50 MiB → FS_FILE_TOO_LARGE,视图显示「图片过大」提示而不读入。
- 图片居中,`max-width/max-height: 100%` + `object-fit: contain` 缩放适应;图片背后棋盘格(语义 token 色,亮暗主题都可辨);
  右下角显示「宽 × 高 · 文件大小」(VSCode 在状态栏;Continuo 状态栏对图片 tab 不显示行 / 词 / 字符统计)。
- 不可编辑、不变脏、不参与自动保存;⌘S 对图片 tab 是 no-op(不写盘、不报错)。
- 外部修改:外部同步对图片 tab 只做 `stat`,指纹变化 → reloadEpoch 递增 → 视图重挂并重新读图;删除 → 与干净文本 tab
  同一出口(removePaths 关闭 tab;图片 tab 永不脏,不会进入 orphaned)。
- 可访问性:视图根可聚焦(tabIndex=0,F6 / 点 tab / 打开后焦点落点),名称「<文件名>，图片预览」
  (en `<name>, Image Preview`,ko `<name>, 이미지 미리 보기`)。

### Markdown 图片(Milkdown 编辑 / 预览)

- 行内 image 节点经自定义 nodeView 渲染(不启用 Crepe ImageBlock,不改变序列化):`src` 原样留在文档里,保存后仍是 `./q.png`。
- 解析规则(`resolveMarkdownImageSource`):
  - 相对 / 绝对本地路径 → 按 md 所在目录解析(同链接解析 `resolveLink`,含 `%20` 解码、`..` 折叠、UNC 限制),
    再经 `fs:read-image` 且 `workspaceOnly`:主进程先字面判定、再 realpath 判定在**发送窗口的工作区根**内(符号链接逃逸拒绝),
    工作区外 / 无工作区 → FS_DENIED。非图片扩展名不请求。
  - `https:` → 原样加载(CSP `img-src https:` 现状,与 VSCode 默认一致);`data:image/*` → 原样。
  - `http:` / `file:` / 其它协议 → 不加载。
- 加载失败或不加载 → 渲染 alt 文字占位(虚线框,`role=img` 名称「图片无法显示：<alt>」),不出现破图图标。

## Modules

| File | Role |
|---|---|
| `electron/shared/image-preview.ts` | 可预览扩展名 → MIME、`MAX_IMAGE_PREVIEW_BYTES` |
| `electron/main/ipc/fs/read-image.ts` | `readImage(path, workspaceRoot?)`:格式 / 工作区(字面 + realpath)/ 大小校验 → data URL |
| `electron/main/ipc/fs.ipc.ts` | 注册 `fs:read-image`(workspaceOnly 时取发送窗口工作区根) |
| `electron/preload/index.ts` | `coApi.fs.readImage(path, opts?)` |
| `src/panels/Editor/editor-image.ts` | `readEditorFile`(图片 → stat 指纹)、`formatBinarySize` |
| `src/panels/Editor/ImageViewer.tsx` | 只读图片视图 |
| `src/panels/Editor/markdown-image-view.ts` | `resolveMarkdownImageSource` + Milkdown image nodeView |
| `src/panels/Editor/EditorPanel.tsx` / `editor-file-actions.ts` / `useExternalFileSync.ts` / `editor-file-deps.ts` | 路由、⌘S no-op、外部同步 |

## Specs

- `read-image.spec.ts`:主进程读图(格式、上限、工作区与符号链接逃逸)
- `open-image.spec.tsx`:打开 / 视图 / 保存 no-op / 超限提示 / 外部修改重载
- `markdown-image.spec.tsx`:解析规则 + 真实 Crepe 渲染与序列化不变
