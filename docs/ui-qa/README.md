# 生成字幕流水线 UI 修复 · 浏览器实测截图

2026-09-05，Chromium headless 实测（puppeteer-core），本地 8400 静态页面。

## 修复前（before-*）

| 文件 | 问题 |
|---|---|
| `before-single-fullwidth-line.png` | 步骤之间的连接线是全宽横线，被误读成「3 个进度条」；上传显示「0 MB 已接收」（size_mb 二次除以 1048576） |
| `before-batch-file2-stale.png` | 批量上传到第 2 个文件时，步骤 1 还是第 1 个文件的 ✓，步骤 3 残留第 1 个文件的旧任务 ✓（步骤不复位） |

## 修复后（after-*）

| 文件 | 验证点 |
|---|---|
| `after-single-done.png` | 标准垂直时间线：短竖连接线对齐圆点中轴；「1.8 MB 已接收」「音频 0.6 MB」「任务 20260905-77996e」；完成有 toast + 绿色状态行，任务行立即出现 |
| `after-batch-file2-reset.png` | 批量第 2 个文件开始时步骤已复位：步骤 1 显示「文件 2/2 · 0.2 MB 已接收」，步骤 3 空闲无残留 |
| `after-batch-done.png` | 批量完成：三步全 ✓，「批量完成：已提交 2/2 项」，fill 归零无回退动画 |

## 覆盖的缺陷

1. 上传显示 0 MB（size_mb 重复换算）
2. 批量多文件时流水线步骤不复位
3. 轮询跳过 extracting 阶段时步骤 2 卡 active 不亮
4. 单文件完成无 toast/状态行反馈
5. 全宽横线误读为进度条（改垂直时间线）
6. dispatch fill 100%→0 回退动画（归零时瞬时切换）
7. 轮询跳过 dispatching 直接 done 时 fill 不补到 100%
