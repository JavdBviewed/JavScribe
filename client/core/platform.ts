// 平台适配层：UI 共享层（ui/app.ts）里的四类"平台动词"
// （选文件 / 选文件夹 / 写回源目录 / 触发下载）按形态分派：
//   - web 形态（platform-web）：File System Access API + <input type=file> 兜底
//   - desktop 形态（platform-desktop，二期）：Electron IPC → main 进程
//     （原生对话框 / 本地递归枚举 / fs 写回 / 保存对话框下载）
//
// 约定：pick* 返回 null 表示用户取消；返回 "fallback" 表示本形态没有原生
// 选择器，由调用方回退到 <input> 路径（保持 web 旧行为 1:1）。

/** 单文件选取结果（dirHandle 仅 web 形态有；desktop 路径挂在 file._localPath） */
export interface PickedFile {
  file: File;
  dirHandle: FileSystemDirectoryHandle | null;
}

/** 「选择文件夹」里的视频项（含所在目录句柄，用于完成后写回源目录） */
export type FolderFile = File & { _dirHandle?: FileSystemDirectoryHandle | null; _localPath?: string };
export interface FolderVideo { file: FolderFile; hasSub: boolean; }

/** 任务完成后写回所需上下文（dispatch 时捕获） */
export interface WriteBackInfo {
  engine: string;
  videoName: string;
  /** web：File System Access 目录句柄 */
  dirHandle: FileSystemDirectoryHandle | null;
  /** desktop：影片绝对路径（main 进程 fs 写回） */
  videoPath?: string | null;
}

export interface PlatformAdapter {
  kind: "web" | "desktop";
  /**
   * 选单个视频文件。
   * web：FS picker（含 getParent 目录句柄）；无 FS picker → "fallback"（调用方走 <input>）
   * desktop：原生 openFile 对话框（结果 File 上挂 _localPath）
   */
  pickVideoFile(): Promise<PickedFile | "fallback" | null>;
  /**
   * 选文件夹并在本地递归过滤视频 + 判定已有字幕（与服务端默认规则一致）。
   * web：showDirectoryPicker(readwrite) + walk；不可用 → "fallback"
   * desktop：原生 openDirectory + main 进程枚举
   */
  pickVideoFolder(): Promise<FolderFile[] | "fallback" | null>;
  /** 是否具备写回源目录的能力（web: 有 dirHandle；desktop: 有 videoPath） */
  canWriteBack(info: WriteBackInfo): boolean;
  /**
   * 把 srt 写回影片同目录（<stem>.zh.srt）。
   * 返回 false = 失败，由调用方回退自动下载；抛错时 err.name/err.message 用于文案。
   */
  writeSrt(info: WriteBackInfo, srtName: string, data: ArrayBuffer): Promise<boolean>;
  /** 触发"保存/下载 srt"（web: <a download> 点击；desktop: 保存对话框） */
  downloadSrt(url: string, filename: string): void;
}
