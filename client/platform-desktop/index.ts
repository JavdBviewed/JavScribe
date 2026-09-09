// desktop 形态平台适配：原生对话框 / 本地递归枚举 / fs 写回 / 保存对话框下载（全部走 IPC）。
// 与 platform-web 同接口（core/platform.ts）；desktop 恒有原生能力，不返回 "fallback"。
// 对话框选中的真实文件以 File shim 进入 UI（size/webkitRelativePath 打标签，
// 真实字节不经过 renderer：提取/上传都由 main 按 _localPath 流式读盘）。

import type {
  FolderFile, PickedFile, PlatformAdapter, WriteBackInfo,
} from "../core/platform";
import type { JavDesktop } from "../core/desktop-bridge";

const desktop: JavDesktop = (window as unknown as { javDesktop: JavDesktop }).javDesktop;

/** 空内容 File shim：size 打标签（UI 展示/判定用），真实内容 main 侧按路径读 */
function shimFile(name: string, size: number, localPath: string, rel?: string): FolderFile {
  const f = new File([new Blob()], name) as FolderFile;
  Object.defineProperty(f, "size", { value: size, configurable: true });
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel, configurable: true });
  f._localPath = localPath;
  return f;
}

export const desktopPlatform: PlatformAdapter = {
  kind: "desktop",

  async pickVideoFile() {
    const r = await desktop.pickVideoFile();
    if (!r) return null; // 用户取消
    const file = shimFile(r.name, r.size, r.path);
    return { file, dirHandle: null } satisfies PickedFile;
  },

  async pickVideoFolder() {
    const items = await desktop.pickVideoFolder();
    if (!items) return null; // 用户取消
    // 视频过滤/字幕判定由 app.setFolder 统一做（与 web 同一路径）
    return items.map((it) => shimFile(it.name, it.size, it.path, it.rel));
  },

  canWriteBack: (info) => !!info.videoPath,

  async writeSrt(info, srtName, data) {
    const r = await desktop.writeSrt(info.videoPath!, srtName, new Uint8Array(data));
    if (!r.ok) throw new Error(r.error || "写回失败");
    return true;
  },

  // 保存对话框（main 进程拉 srt + 清洗 + 写盘）；取消/失败静默（与 web <a download> 一致）
  downloadSrt(url, filename) {
    void desktop.download(url, filename);
  },

  // 音轨缓存（任务表「换服务重跑」）；main 侧 audio-cache/ 查询
  findAudioCache(videoName) {
    return desktop.audioCache.find(videoName);
  },
};
