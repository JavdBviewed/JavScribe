// 跨形态共享常量（与服务端 audio.py / 扫描规则默认值保持一致）

/** 本地过滤用视频扩展名 */
export const VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "ts", "m2ts", "mpg", "mpeg"];

/** 本地判断「已有字幕」的文件名模式（与服务端默认一致，仅本地过滤用） */
export const LOCAL_SUB_PATTERNS = [".zh.srt", ".srt"];

/** 写回/下载的 srt 命名：影片 stem + .zh.srt */
export const SRT_SUFFIX = ".zh.srt";

/** ffmpeg.wasm 线性内存上限 ~2GB，1.6GB 是含中间数据的安全上限（与服务端一致） */
export const DEFAULT_MAX_EXTRACT_BYTES = Math.floor(1.6 * 1024 * 1024 * 1024);

/** 与服务端 audio_args 完全一致的本地提取参数（16kHz 单声道 opus @32kbps） */
export const OPUS_EXTRACT_ARGS = [
  "-vn", "-c:a", "libopus", "-ar", "16000", "-ac", "1", "-b:a", "32k",
] as const;

/** auto 均衡派发显存阈值（GB）内置缺省：客户端设置 vram_free_min_gb 缺失/脏值时回落到本值。
 * 取值依据：whisper-large-v2 单实例驻留约 5G+ 显存（权重 + 激活缓存），缺省 5 = 「至少还能坐下 1 个实例」；
 * 并发超发由服务端显存预检 + OOM 韧性兜底（10-13 线曾取 10，把空闲 9G 的整机永久踢出均衡池导致整批钉单机，
 * 0.2.47 降回下限并改为客户端可调：设置 vram_free_min_gb，0 = 不过滤）。
 * 全部候选都不足 → 回退「在途最少」保证不卡派发；无 metrics 数据（旧版 serve / 未采样）视为满足、不过滤。 */
export const MIN_FREE_VRAM_GB = 5;
