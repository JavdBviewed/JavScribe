// 0.2.52 M1：提交时刻按盘拆 batch——分组/label 纯逻辑（desktop/web 共用，单测可直接 import）。
// 分组键口径 = diskKeyOf（client/core/disk-key.ts，不许改）；同键同组，组序=首见序。
import { diskKeyOf } from "./disk-key";

export interface DiskGroup<T> {
  /** diskKeyOf 键（"" = 无盘维度，如 web 形态无 _localPath 的合成文件） */
  key: string;
  /** 组内项（保持传入顺序） */
  items: T[];
  /** 组内目录名（首见序去重；多组 label「、」连接用） */
  dirNames: string[];
}

/**
 * 按盘分组。keyOf 决定组（内部统一过 diskKeyOf 再兜底），dirNameOf 供 label。
 * 空键项归入 "" 组（web 形态全量同组 → 退化单组，行为与现状一致）。
 */
export function groupByDisk<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  dirNameOf: (item: T) => string,
): DiskGroup<T>[] {
  const groups = new Map<string, DiskGroup<T>>();
  for (const it of items) {
    const key = keyOf(it) || "";
    let g = groups.get(key);
    if (!g) {
      g = { key, items: [], dirNames: [] };
      groups.set(key, g);
    }
    g.items.push(it);
    const dn = dirNameOf(it) || "";
    if (dn && !g.dirNames.includes(dn)) g.dirNames.push(dn);
  }
  return [...groups.values()];
}

/** 便捷重载：直接按绝对路径分组（文件夹/扫描两路径的 diskKeyOf 口径）。 */
export function splitPathsByDisk(paths: readonly string[]): DiskGroup<string>[] {
  return groupByDisk(
    paths,
    (p) => diskKeyOf(p),
    (p) => {
      const segs = p.split(/[\\/]+/).filter(Boolean);
      if (segs.length > 1) return segs[segs.length - 2];
      return segs.length === 1 ? segs[0] : "";
    },
  );
}

/**
 * 多组时的 batch label：「盘符·目录名」（同组多目录名「、」连接）。
 * 单组不调用（维持现状 label 口径，不加盘符，零噪音）。
 */
export function multiGroupLabel(g: { key: string; dirNames: string[] }): string {
  const dirs = g.dirNames.join("、") || "目录";
  return g.key ? `${g.key}·${dirs}` : dirs;
}

/**
 * 文件夹路径（startBatch）逐组 label 三级决策（验收口径）：
 *  - 多组 → 「盘符·目录名」（multiGroupLabel，同组多目录名「、」连接）
 *  - 单组多目录（同顶层多选，rel 首段各不同）→ 目录名「、」连接（无盘符）
 *  - 单组单目录 → 调用方现状 label（batchLabelForFolder，零噪音）
 * 扫描路径（scanSubmit）单组恒用现状 label（扫描目录名），不走本函数「、」分支。
 */
export function folderGroupLabel(
  g: { key: string; dirNames: string[] },
  multi: boolean,
  singleLabel: string,
): string {
  if (multi) return multiGroupLabel(g);
  if (g.dirNames.length > 1) return g.dirNames.join("、");
  return singleLabel;
}
