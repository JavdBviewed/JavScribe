// JavScribe Client — preload（contextBridge，contextIsolation: true）
// 只暴露白名单方法，不暴露 ipcRenderer 本体；Node/Buffer 不进入 renderer。
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  ExtractResult, FileOpResult, JavDesktop, PickFileResult,
  PickFolderItem, TCallResult, TProgress, UploadDispatchResult,
} from "../core/desktop-bridge";

const api: JavDesktop = {
  call: (method: string, args?: string[]) =>
    ipcRenderer.invoke("t-call", { method, args }) as Promise<TCallResult>,

  pickVideoFile: () => ipcRenderer.invoke("pick-video-file") as Promise<PickFileResult | null>,

  pickVideoFolder: () =>
    ipcRenderer.invoke("pick-video-folder") as Promise<PickFolderItem[] | null>,

  writeSrt: (videoPath: string, srtName: string, data: Uint8Array) =>
    ipcRenderer.invoke("write-srt", { videoPath, srtName, data }) as Promise<FileOpResult>,

  download: (url: string, filename: string) =>
    ipcRenderer.invoke("download-srt", { url, filename }) as Promise<FileOpResult>,

  filePath: (f: File): string => {
    try {
      return webUtils.getPathForFile(f) || "";
    } catch {
      return "";
    }
  },

  // 提取进度走 main→renderer 推送事件；同一时刻仅一个提取任务（UI 串行队列）
  extractAudio(args: { videoPath?: string; data?: Uint8Array }, onProgress?: (frac: number) => void) {
    if (onProgress) {
      const listener = (_e: unknown, p: { frac: number }) => onProgress(p.frac);
      ipcRenderer.on("extract-progress", listener);
      return ipcRenderer.invoke("extract-audio", args)
        .then((r) => {
          ipcRenderer.removeListener("extract-progress", listener);
          return r;
        }) as Promise<ExtractResult>;
    }
    return ipcRenderer.invoke("extract-audio", args) as Promise<ExtractResult>;
  },

  onTProgress(cb: (p: TProgress) => void): () => void {
    const listener = (_e: unknown, p: TProgress) => cb(p);
    ipcRenderer.on("t-progress", listener);
    return () => {
      ipcRenderer.removeListener("t-progress", listener);
    };
  },
};

// 上传通道独立于 t-call（main 侧需要对象参数）
const upload = {
  audio: (args: { id: string; engine: string; name: string; opusPath?: string; data?: Uint8Array }) =>
    ipcRenderer.invoke("upload-audio", args) as Promise<UploadDispatchResult>,
  file: (args: { id: string; engine: string; name: string; ext: string; localPath?: string; data?: Uint8Array }) =>
    ipcRenderer.invoke("upload-file", args) as Promise<UploadDispatchResult>,
};

contextBridge.exposeInMainWorld("javDesktop", { ...api, upload });
