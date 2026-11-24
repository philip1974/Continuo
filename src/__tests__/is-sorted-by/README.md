# isSortedBy(「已有序则跳过排序」判断的共享实现)

行为契约:**按给定比较器判断列表是否已非降序。**

命令面板、快捷键页(命令 + 分组两处)、Explorer 右键菜单插件分组在排序前都先判一次「已有序就不排 / 不拷贝」
(此前四处各手写一份相同循环)。

## 行为

- 空列表、单项 → true。
- 相邻两项 `compare(prev, cur) > 0` 任一成立 → false;相等项不算乱序。
- 不修改入参。

## 接线守卫

三个调用方文件的源码都引用 `isSortedBy`,且不再含 `function isSortedByDisplayTitle` / `areBucketsSortedByCategory` /
`arePluginItemBucketsSorted` 手写副本。
