# Plugin 发布手册

把你的 Continuo 插件放到插件商店里,让用户一键安装 + 自动更新提示。

> 配套:
> - [12-plugin-permissions.md](./12-plugin-permissions.md) — 写 plugin 时的权限模型
> - [13-插件商店.md](./13-插件商店.md) — 商店架构计划
> - 索引仓库 [philip1974/continuo-plugins](https://github.com/philip1974/continuo-plugins) — PR 提到这里

## 1. 走完整流程之前

确认你的 plugin:

- [ ] **public GitHub repo**(私有 / Bitbucket / GitLab 暂不支持,Continuo
      只走 `https://github.com/...` git clone)
- [ ] **manifest.json** 在 repo 根目录,字段完整(`id` / `name` / `version`
      / `main` / 可选 `permissions`,详见 doc/10 + zod schema)
- [ ] **main.js** 在 repo 根目录或 `manifest.main` 指向(默认 `main.js`)
- [ ] 在最新 dev Continuo 上手测过:`coApi.plugins.installFromGit(your-url)`
      装上 + 启用 + 核心命令跑通(可在 Settings → 插件 → "从 git URL 安装" UI 跑)
- [ ] 没在 plugin 里直接调 `window.api.*` / `globalThis.fetch` /
      `navigator.clipboard`(走 `this.app.fs/network/clipboard`,通过权限门)
- [ ] 声明的 `permissions` 真用得上(用户事后在 [权限] Modal 看,缺信任会 deny)

## 2. 上架(提 PR)

1. fork [philip1974/continuo-plugins](https://github.com/philip1974/continuo-plugins)
2. 在 `index.json` 数组末尾追加你的条目:

   ```json
   {
     "id": "com.your.plugin",
     "name": "Your Plugin",
     "description": "做啥的,一句话",
     "author": "your-handle",
     "authorUrl": "https://github.com/your-handle",
     "repo": "your-handle/your-plugin-repo",
     "branch": "main",
     "tags": ["productivity"]
   }
   ```

3. 提 PR,GitHub 会自动套 `.github/PULL_REQUEST_TEMPLATE.md`。
   照模板填:plugin 信息 + 用途 + 截图(可选)+ 自测 checklist
4. 等 review。**不要自填 `verified: true`**,review 后由维护者加。

## 3. 字段细节

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 反 DNS 唯一,**与 `manifest.json` 的 `id` 一致**(否则 install 后 plugin manager 找不着) |
| `name` | ✓ | 商店列表显示名 |
| `description` | | 1-2 句话,不超 80 字 |
| `author` | ✓ | 作者 handle |
| `authorUrl` | | 作者主页 |
| `repo` | ✓ | `owner/name`,**不带** `https://github.com/` 前缀 |
| `branch` | | 默认 `main`,有特殊分支才填 |
| `tags` | | 推荐 `productivity` / `theme` / `dev-tools` / `editor` /
              `ai` 等,自由扩展 |
| `verified` | | 维护者填,你别填 |

`version` **不在索引里写** — 插件版本从你的 `manifest.json` `version` 字段拉。
每次发新版,bump manifest 的 version,push,Continuo 会自动检测到更新提示用户。

## 4. 发新版

1. 改你的 plugin 代码
2. bump `manifest.json` 的 `version`(semver `X.Y.Z`)
3. commit + push 到默认分支
4. 完事 — 用户的 Continuo 启动时 marketplace 会拉新 manifest,数字角标 + [更新到 vX] 按钮自动出现

不需要改索引仓库。

## 5. 用户视角

用户从 Settings → 插件商店 看到你的插件:

- 卡片显:name + verified 徽章(若有)+ description + 你 author + tags + repo 链接
- 按钮:`[安装]` / `[已安装]` / `[已安装(待重启)]` / `[更新到 vX]`
- 安装走 `installFromGit(your-repo-git-url)`,装到 `~/Library/Application Support/Continuo/plugins/<id>/`
- 重启 Continuo 后插件加载;若 manifest 声明了 `permissions`,首次启用弹"权限请求"Modal

## 6. 维护

被合并后:
- review feedback 跟进,问题大可能取消 verified 标记
- repo 长期失修(如 1 年无 commit + 用户报错积累)可能从索引下架
- 用户提的 issue / PR 优先在你的 plugin repo 处理;商店相关的提 `philip1974/continuo-plugins`

## 7. 反馈

文档 / 流程不清楚 → 提 issue 到 `philip1974/Continuo`。

不熟 PR → 索引仓库 issue 直接贴你的字段,我们帮你加。
