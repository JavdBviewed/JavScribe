"""serve 音轨内容寻址缓存测试（/upload 去重、/cache/check、/upload/submit，无 GPU 依赖）。

Run:  python3 tests/test_audio_cache.py
Covers: 内容寻址存储 + 同内容去重、声明 sha1 校验（不匹配 400）、
/cache/check 命中/未命中/size 不匹配/非法参数、/upload/submit 命中建任务/
未命中 409、旧客户端（无 sha1/ext 参数）兼容、流式上传不整包驻留内存。
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.progress_api import ProgressHTTP  # noqa: E402

BASE_CFG = {
    "infer": {"device": "cuda"},
    "subtitle": {"formats": ["srt"], "lang_tag": "zh", "skip_if_exists": True},
}


class FakeEngine:
    """Duck-typed Engine：只覆盖缓存链路用到的方法。"""

    def __init__(self) -> None:
        self.cfg = dict(BASE_CFG)
        self.jobs: list = []
        self._seq = 0

    def log(self, _msg: str) -> None:
        pass

    def job_by_id(self, _id: str):
        return None

    def result_srt_bytes(self, _job):
        return None

    def submit_remote_files(self, files, source_name=None):
        self._seq += 1
        job = SimpleNamespace(id=f"20260910-{self._seq:06d}", files=files, label=source_name)
        self.jobs.append(job)
        return job


def _raw(method: str, url: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Length", str(len(data)))
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as ex:
        raw = ex.read().decode()
        try:
            return ex.code, json.loads(raw)
        except json.JSONDecodeError:
            return ex.code, {"raw": raw}


def _start(td: Path):
    http = ProgressHTTP(
        FakeEngine(), host="127.0.0.1", port=0, profile="server", inbox_dir=td / "inbox"
    )
    http.start()
    return http


def _put_upload(base: str, body: bytes, query: str = "", headers: dict | None = None):
    return _raw("PUT", f"{base}/upload{query}", body, headers or {"X-Source-Name": "TST-001.mp4"})


def test_upload_content_addressed_and_dedup() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        http = _start(td)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            body = b"\x01\x00opus-bytes" * 1000
            want = hashlib.sha1(body).hexdigest()

            code, r = _put_upload(base, body)
            assert code == 201 and r["ok"], (code, r)
            assert r["sha1"] == want, r
            assert r["file"] == f"{want}.opus", r
            assert (td / "inbox" / f"{want}.opus").read_bytes() == body

            # 同内容二次上传（换个 source 名）：去重复用，inbox 仍只有一个文件
            code, r2 = _put_upload(base, body, "", {"X-Source-Name": "TST-002.mp4"})
            assert code == 201 and r2["sha1"] == want, (code, r2)
            inbox_files = [p for p in (td / "inbox").iterdir() if p.is_file()]
            assert len(inbox_files) == 1, [p.name for p in inbox_files]
            assert len(http.engine.jobs) == 2
            # 不同内容：新文件
            code, r3 = _put_upload(base, body + b"X")
            assert code == 201 and r3["sha1"] != want
            assert len([p for p in (td / "inbox").iterdir() if p.is_file()]) == 2
        finally:
            http.server.shutdown()


def test_upload_declared_sha1() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        http = _start(td)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            body = b"audio-data"
            good = hashlib.sha1(body).hexdigest()
            bad = "0" * 40
            # 声明不匹配 → 400，不建任务不落文件
            code, r = _put_upload(base, body, f"?ext=opus&sha1={bad}")
            assert code == 400 and not r["ok"], (code, r)
            assert not http.engine.jobs
            assert not list((td / "inbox").iterdir()) if (td / "inbox").exists() else True
            # 声明匹配 → 201
            code, r = _put_upload(base, body, f"?ext=opus&sha1={good}")
            assert code == 201 and r["sha1"] == good, (code, r)
            # 非法 sha1 参数 → 400
            code, _ = _put_upload(base, body, "?ext=opus&sha1=xyz")
            assert code == 400, code
            # 旧客户端：不带 sha1/ext 参数（默认 opus）→ 201 内容寻址命名
            code, r = _put_upload(base, b"legacy")
            assert code == 201 and r["file"].endswith(".opus"), (code, r)
            assert r["file"] == hashlib.sha1(b"legacy").hexdigest() + ".opus", r
        finally:
            http.server.shutdown()


def test_cache_check() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        http = _start(td)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            body = b"check-me"
            h = hashlib.sha1(body).hexdigest()
            # 未命中
            code, r = _raw("GET", f"{base}/cache/check?sha1={h}&size={len(body)}&ext=opus")
            assert code == 200 and r == {"ok": True, "cached": False}, (code, r)
            # 上传后命中（size 校验通过）
            _put_upload(base, body)
            code, r = _raw("GET", f"{base}/cache/check?sha1={h}&size={len(body)}&ext=opus")
            assert code == 200 and r["cached"] is True and r["size"] == len(body), (code, r)
            # size 不匹配 → 视为未命中
            code, r = _raw("GET", f"{base}/cache/check?sha1={h}&size={len(body) + 1}&ext=opus")
            assert code == 200 and r["cached"] is False, (code, r)
            # ext 不同 → 未命中
            code, r = _raw("GET", f"{base}/cache/check?sha1={h}&ext=mp4")
            assert code == 200 and r["cached"] is False, (code, r)
            # 非法 sha1 → 400
            code, _ = _raw("GET", f"{base}/cache/check?sha1=abc")
            assert code == 400, code
            # 无 sha1 → 400
            code, _ = _raw("GET", f"{base}/cache/check?size=8")
            assert code == 400, code
        finally:
            http.server.shutdown()


def test_upload_submit() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        http = _start(td)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            body = b"submit-me"
            h = hashlib.sha1(body).hexdigest()
            # 未缓存 → 409 not-cached
            code, r = _raw("POST", f"{base}/upload/submit?sha1={h}&ext=opus",
                           headers={"X-Source-Name": "SUB-001.mp4"})
            assert code == 409 and r["error"] == "not-cached", (code, r)
            assert not http.engine.jobs
            # 上传后命中 → 201 建任务（无 body）
            _put_upload(base, body)
            n_jobs = len(http.engine.jobs)
            code, r = _raw("POST", f"{base}/upload/submit?sha1={h}&ext=opus",
                           headers={"X-Source-Name": "SUB-001.mp4"})
            assert code == 201 and r["ok"] and r["cached"] is True, (code, r)
            assert len(http.engine.jobs) == n_jobs + 1
            # 任务引用缓存文件
            task_path = http.engine.jobs[-1].files[0]
            assert Path(task_path).name == f"{h}.opus", task_path
            # 非法 sha1 → 400
            code, _ = _raw("POST", f"{base}/upload/submit?sha1=zzz&ext=opus")
            assert code == 400, code
        finally:
            http.server.shutdown()


def test_chunked_large_upload_no_memory_spike() -> None:
    """>1 块的上传走流式路径（行为等价：内容寻址 + 201）。"""
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        http = _start(td)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            body = os.urandom(3 * 1024 * 1024 + 12345)
            h = hashlib.sha1(body).hexdigest()
            code, r = _put_upload(base, body)
            assert code == 201 and r["sha1"] == h, (code, r)
            assert (td / "inbox" / f"{h}.opus").read_bytes() == body
        finally:
            http.server.shutdown()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok - {name}")
    print("ALL PASS")
