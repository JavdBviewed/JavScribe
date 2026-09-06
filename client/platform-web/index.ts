// web 形态平台适配：浏览器原生机制原样封装（行为与迁移前 app.ts 内联逻辑 1:1）
//  - 选文件：File System Access API（安全上下文）；不可用 → "fallback"（<input type=file>）
//  - 选文件夹：showDirectoryPicker(readwrite) + 递归 walk；不可用 → "fallback"（webkitdirectory）
//  - 写回：FS Access createWritable；下载：<a download> 点击

import type {
  FolderFile, PickedFile, PlatformAdapter, WriteBackInfo,
} from "../core/platform";
import { VIDEO_EXTS } from "../core/constants";
import { toast } from "../ui/toast";

const fsWin = window as Window & {
  showOpenFilePicker?: (opts?: { multiple?: boolean; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};
const HAS_FS_PICKER = typeof fsWin.showOpenFilePicker === "function"
  && typeof fsWin.showDirectoryPicker === "function";

async function walkDirForFiles(dir: FileSystemDirectoryHandle, prefix: string, out: FolderFile[]) {
  for await (const entry of dir.values()) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.kind === "file") {
      const f = (await entry.getFile()) as FolderFile;
      Object.defineProperty(f, "webkitRelativePath", { value: rel });
      f._dirHandle = dir; // 记录所在目录句柄，任务完成后把 srt 写回这里
      out.push(f);
    } else if (entry.kind === "directory") {
      await walkDirForFiles(entry, rel, out);
    }
  }
}

export const webPlatform: PlatformAdapter = {
  kind: "web",

  async pickVideoFile() {
    if (!HAS_FS_PICKER) return "fallback";
    try {
      const [h] = await fsWin.showOpenFilePicker!({
        multiple: false,
        types: [{ description: "视频文件", accept: { "video/*": VIDEO_EXTS.map((e) => "." + e) } }],
      });
      const f = await h.getFile();
      const dirHandle = await (h as FileSystemFileHandle & {
        getParent(): Promise<FileSystemDirectoryHandle>;
      }).getParent();
      return { file: f, dirHandle } satisfies PickedFile;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") toast("选择文件失败：" + err.message, "err");
      return null;
    }
  },

  async pickVideoFolder() {
    if (!HAS_FS_PICKER) return "fallback";
    let root: FileSystemDirectoryHandle;
    try {
      root = await fsWin.showDirectoryPicker!({ mode: "readwrite" });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") toast("选择文件夹失败：" + err.message, "err");
      return null;
    }
    const files: FolderFile[] = [];
    try {
      await walkDirForFiles(root, root.name, files);
    } catch (e) {
      toast("读取文件夹失败：" + (e as Error).message, "err");
      return null;
    }
    return files;
  },

  canWriteBack: (info) => !!info.dirHandle,

  async writeSrt(info, srtName, data) {
    const fh = await info.dirHandle!.getFileHandle(srtName, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
    return true;
  },

  downloadSrt(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};
