"""serve 根目录测试统一环境钉死（pytest 最先加载）。

fake 推理引擎是普通脚本（不实现 ChickenRice --server 常驻协议），
全套件钉死经典一次性进程路径，保证 0.2.16 warm pool 上线后既有
用例行为不变。warm 路径专属用例在 tests/test_warm_pool.py
（显式删掉本变量 + fake ChickenRice 常驻服）。
"""
import os

os.environ["JAVSCRIBE_NO_WARM"] = "1"
