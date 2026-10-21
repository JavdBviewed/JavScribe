// 0.2.52 多盘符主任务：文件「盘」分组键（按盘拆 batch / 本机提取池公平准入共用口径）。
// 口径：
//   Win：盘符（D:）；UNC（\\server\share）→ 原样整串（反斜杠归一为 / 并去尾部 /）
//   Linux/macOS：取顶层段 = 挂载点粒度（/tmp/x → /tmp，/home/ryen/x → /home，/media/jav/x → /media）
//   相对路径 / 纯文件名 / 空 → ""（无盘维度；调用方按单组 / 无分组处理）
export function diskKeyOf(p: string): string {
  if (!p) return "";
  if (/^[a-zA-Z]:[\\\/]/.test(p)) return p[0].toUpperCase() + ":";
  if (p.startsWith("\\\\") || p.startsWith("//")) {
    // UNC 按 服务器\共享 归组
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length >= 2) return `//${parts[0]}/${parts[1]}`;
    if (parts.length === 1) return `//${parts[0]}`;
    return p.replace(/\\/g, "/");
  }
  if (p.startsWith("/")) {
    const parts = p.split("/").filter(Boolean);
    if (parts.length >= 1) return `/${parts[0]}`;
    return "/";
  }
  return "";
}
