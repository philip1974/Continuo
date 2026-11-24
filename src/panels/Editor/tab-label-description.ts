// 同名文件 tab 的区分后缀(对齐 VSCode 编辑器标签 labelFormat=default):basename 重复时,在文件名后显示能把它与
// 其它同名 tab 区分开的**最短**父路径后缀(`a` / `a/src`);不重名的 tab 不显示。父链用尽仍不能区分(一个是
// 另一个的后缀路径、或同一路径重复)时显示完整父目录。
import { basename, dirname } from '@/lib/path-cross';

/** 父目录各段(不含空段与文件名)及该路径使用的分隔符。 */
function parentSegments(filePath: string): { segs: string[]; sep: string } {
  const segs = filePath.split(/[\\/]/).filter((s) => s !== '');
  segs.pop();
  return { segs, sep: filePath.includes('\\') ? '\\' : '/' };
}

const suffix = (segs: readonly string[], k: number, sep: string): string => segs.slice(-k).join(sep);

/** 与 `filePaths` 一一对应:需要区分的 tab 给出父路径后缀,其余为 null。 */
export function tabLabelDescriptions(filePaths: readonly string[]): (string | null)[] {
  const byName = new Map<string, number[]>();
  filePaths.forEach((p, i) => {
    const name = basename(p);
    const group = byName.get(name);
    if (group) group.push(i);
    else byName.set(name, [i]);
  });
  const out: (string | null)[] = filePaths.map(() => null);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const parsed = group.map((i) => parentSegments(filePaths[i]!));
    group.forEach((i, gi) => {
      const { segs, sep } = parsed[gi]!;
      for (let k = 1; k <= segs.length; k += 1) {
        const mine = suffix(segs, k, sep);
        const clash = parsed.some((o, gj) => gj !== gi && suffix(o.segs, k, o.sep) === mine);
        if (!clash) {
          out[i] = mine;
          return;
        }
      }
      out[i] = dirname(filePaths[i]!);
    });
  }
  return out;
}
