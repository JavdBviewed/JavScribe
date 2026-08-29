# 模型要求与部署教程

JavScribe 本体不含任何模型。它调用的是 **TransWithAI ChickenRice（海南鸡）** 这个
基于 faster-whisper (CTranslate2) 的日→中工具，你需要自备以下模型权重。

## 1. 需要的模型

| 模型 | 用途 | 来源 | 体积(约) |
|---|---|---|---|
| **海南鸡 v2** `whisper-large-v2-translate-zh-v0.2-st-ct2` | **主模型**：日语→中文一步完成（ASR+翻译），5000h 日语数据微调 | Hugging Face: `chickenrice0721/whisper-large-v2-translate-zh-v0.2-st-ct2`；或直接用 ChickenRice 仓库的「翻译版」发布包（含模型） | ~3 GB (CT2) |
| `Whisper-Vad-EncDec-ASMR-onnx` | 为安静/非语音素材调过的 VAD（这类素材非语音段多，建议保留） | Hugging Face: `TransWithAI/Whisper-Vad-EncDec-ASMR-onnx`；ChickenRice 发布包已内置 | <100 MB |
| `whisper-base`（仅配置文件） | VAD 的 feature extractor（离线用），只需 4 个 json，**无需权重** | Hugging Face: `openai/whisper-base` | <1 MB |
| `whisper-ja-1.5B-ct2`（可选） | 日语**原文**字幕转录（不翻译），1.5B 日语微调 | Hugging Face: `TransWithAI/whisper-ja-1.5B-ct2` | ~3 GB |
| 任意 LLM（可选，**默认不用**） | 字幕**润色第二遍**校对（错译/不通顺）。任何 OpenAI 兼容端点均可（自建 Ollama/vLLM 或商业 API） | 你已有的端点 | 你已有 |

> 说明：ja→zh 主链路是"海南鸡"一个模型完成，**不需要 LLM 参与**。
> LLM 只在你想要更精的校对时作为可选第二遍使用（config `polish.enabled=true`）。

## 2. 三种部署形态

### A. 最省事：ChickenRice 发布包（推荐 Windows 本地）

1. 从 ChickenRice 仓库 Releases 下载**翻译版**包（含 `infer.exe` + VAD + 海南鸡 v2 模型）
2. 解压到固定目录，例如 `C:\Tools\ChickenRice\`
3. 配置里指向它：

```json
"infer": {
  "command": "C:\\Tools\\ChickenRice\\infer.exe",
  "model": "models",          // 包内 models/ 根目录即海南鸡 v2
  "device": "cpu"
}
```

> `infer.exe` 是 PyInstaller 单文件，JavScribe 通过 ConPTY 驱动它，
> 相对路径 `models/` 按 exe 所在目录解析（runner 的 cwd 已自动设为 exe 目录）。

### B. Python 源码形态（推荐 Linux GPU 服务器）

```bash
git clone --depth 1 --branch v1.9 https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice /opt/chickenrice
cd /opt/chickenrice
python3 -m pip install --break-system-packages faster-whisper ctranslate2 transformers librosa onnxruntime pyjson5 requests  # Ubuntu 24.04 需要该参数(PEP 668)
# 下载模型（HF 不可达时脚本自动回退 hf-mirror）：
python3 download_models.py      # VAD + whisper-base 配置
python3 download_models.py --hf-model chickenrice0721/whisper-large-v2-translate-zh-v0.2-st-ct2
```

JavScribe 配置：

```json
"infer": {
  "command": "python /opt/chickenrice/infer.py",
  "cwd": "/opt/chickenrice",
  "model": "models/whisper-large-v2-translate-zh-v0.2-st-ct2",
  "device": "cuda",
  "batch": true,
  "max_batch_size": 8
}
```

> CLI 参数（按 ChickenRice v1.9 核对）：`--model_name_or_path --device --sub_formats
> --audio_suffixes --log_level --enable_batching --max_batch_size --overwrite`
> + 文件列表（JavScribe 自动拼装）。**`log_level=DEBUG` 必须**：进度时间轴事件
> 只在该级别打印。入口脚本会自动切到仓库根目录，相对 `models/` 按仓库根解析。

### C. 自下载模型

不想用整包：分别下载上表权重，放到 `models/` 下子目录，
`model` 指向具体目录（含 `config.json` + `model.bin` 的 CT2 格式）。

## 3. 显存与设备选择

| 硬件 | 建议 device | 说明 |
|---|---|---|
| NVIDIA ≥8G 显存 | `cuda` + `batch:true` | 甜点。fp16/bf16；24G 级卡 2.5h 影片约 5–15 分钟；与其他服务共卡时注意 VRAM 余量 |
| NVIDIA 4–6G 显存 | `cuda` + int8 | 降精度、关闭 batching |
| CPU（无 NVIDIA 卡） | `cpu` | 建议 int8；2.5h 影片数小时，多核 CPU 可过夜批处理。注意 CTranslate2 的 Windows 侧只有 CUDA/CPU 两种后端 |
| Linux + AMD 卡 | `amd`（ROCm/HIP） | ChickenRice 支持；需 ROCm 环境 |

计算精度：`compute_type` 可选 `auto/bfloat16/float16/int8_float16/int8/...`，
12G 以下的卡或 CPU 建议 int8 系。

## 4. 模型授权（务必看一眼）

- JavScribe 代码：MIT。
- 模型权重**不属于本仓库**，由各自作者发布。使用前请阅读 Hugging Face 模型卡
  的 license（"海南鸡 v2" 由 AI汉化组 社区训练发布；whisper-large-v2 原模型为 MIT）。
- 本仓库只分发代码与配置；权重在你自己的机器上使用，无需对外分发。
