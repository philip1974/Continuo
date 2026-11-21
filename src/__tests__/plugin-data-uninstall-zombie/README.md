# plugin-data-uninstall-zombie(卸载后迟到的 saveData 不复活插件目录)

## 背景

插件数据 `data.json` 存在插件安装目录 `userData/plugins/<id>/` 里。卸载时主进程先删目录并广播,各窗口的
renderer 收到广播后才停用实例、跑 `onunload`(其中常有 `saveData`);吊销后的 scoped app 仍放行 dataStore。
旧实现的 SAVE 无条件 `mkdir -p plugins/<id>`,也不与卸载互斥,于是迟到的 `saveData` 把刚删掉的目录建了回来。
这个目录只有 `data.json`、没有 `manifest.json`:

- 插件列表不列出它 → UI 没有卸载入口;
- 同 id 再安装时目标目录已存在 → 永远 `EEXIST`(「已安装,卸载后再装」),该 id 装不回来。

## 行为

- `plugin-data:save` / `save-serialized` 只写**已安装**插件的目录:写入进同 id 的主进程 mutation 锁(与安装 /
  更新 / 卸载互斥),锁内确认 `plugins/<id>` 目录存在才写;不存在 → 拒绝 `code: 'NOT_INSTALLED'`,**不创建目录**。
  与 path scope 持久化(`persistPluginPathScopesIfInstalled`)同一规则、同一把锁。
  - 卸载完成后才到达的 `saveData` → 被拒,目录不复活。
  - 卸载进行中发起的 `saveData` → 排在卸载之后,同样被拒(不会在 `rm` 之后重建目录)。
  - 已安装插件的保存 / 读取 / 清除不变。`load` / `clear` 本就不创建目录。
- 安装自愈历史残留:`installFromGit` 在锁内发现目标目录是 plugin-data 残留 —— 没有 `manifest.json`,且里面只有
  `data.json` 及其附属文件(`data.json.lock` 锁目录、`data.json.corrupt`、原子写的 `.data.json.*.tmp`),或是空目录
  —— 先清掉再按全新安装继续;残留的 `data.json` 是卸载之后写进来的,不继承。
  - 判定从严:目录里有任何其它条目(用户手放的文件等)→ 不算残留、不删,照旧 `EEXIST`。
  - 有 `manifest.json` 的已安装目录 → 照旧 `EEXIST`(非 overwrite)。

## 实现

- `electron/main/services/plugins.service.ts`:`withInstalledPluginLock`(锁内确认目录存在后执行)、
  `isPluginDataResidueDir` + `installFromGit` 的自愈分支。
- `electron/main/services/plugin-data-store.service.ts`:`writeSerialized` 经 `withInstalledPluginLock`,去掉 `ensureDir`。

## 残余

- 内置插件(静态加载,不在 `plugins/` 下)目前都不使用 dataStore;若将来使用,其数据目录需另行安排(当前规则下
  会得到 `NOT_INSTALLED`)。
- 卸载时在其它窗口 `onunload` 里的 `saveData` 现在会 reject(数据随卸载删除,本就不保留);插件应自行 catch。
