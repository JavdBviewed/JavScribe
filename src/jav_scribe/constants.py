APP_NAME = "JavScribe"
APP_ORG = "JavScribe"
APP_VERSION = "0.1.3"

AUDIO_EXTS = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma", "opus", "mka"]
VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "ts", "m2ts", "mpg", "mpeg"]
ALL_EXTS = AUDIO_EXTS + VIDEO_EXTS
ALL_EXTS_SET = {f".{e}" for e in ALL_EXTS}

SUB_FORMATS = ["srt", "vtt", "lrc", "txt"]
DEFAULT_SUB_FORMATS = ["srt"]

SUB_LANG_TAGS = ["zh", "ja", "en", "none"]
DEFAULT_LANG_TAG = "zh"

DEVICES = ["auto", "cuda", "cpu", "amd"]
COMPUTE_TYPES = ["auto", "bfloat16", "float16", "int8_float16", "int8", "float32", "int16"]
LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"]

SETTINGS_FILE = "gui_settings.json"
CONFIG_FILE = "config.json"
CONFIG_DIR_NAME = ".jav_scribe"

DEFAULT_PROGRESS_HOST = "0.0.0.0"
DEFAULT_PROGRESS_PORT = 8300
REMOTE_AUDIO_KBITRATE = 32  # 16kHz mono opus, ~35MB per 2.5h movie

WORKFLOW_MODES = ["restore_only", "restore_and_subtitle", "subtitle_only"]
WORKFLOW_MODE_LABELS = {
    "restore_only": "仅修复",
    "restore_and_subtitle": "修复+字幕",
    "subtitle_only": "仅字幕",
}

DETECTION_MODELS = [
    "rfdetr-v5",
    "rfdetr-v4",
    "rfdetr-v3",
    "rfdetr-v2",
    "lada-yolo-v2",
    "lada-yolo-v4",
]

SECONDARY_RESTORATION = ["none", "unet-4x", "tvai", "rtx-super-res"]
DENOISE_STRENGTHS = ["none", "low", "medium", "high"]
DENOISE_STEPS = ["after_primary", "after_secondary"]
FILE_CONFLICT_MODES = ["auto_rename", "overwrite", "skip"]
FILE_CONFLICT_LABELS = {
    "auto_rename": "自动重命名",
    "overwrite": "覆盖",
    "skip": "跳过",
}
