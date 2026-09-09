"""srt_sanitizer: 负时间戳/乱序兜底（下载代理侧）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe_web.srt_sanitizer import sanitize_srt_bytes, sanitize_srt_text  # noqa: E402

EVIDENCE = (
    "1\n-1:45:55,320 --> 00:00:23,880\n毕竟科长你啊 只要喝醉了就肯定会搭讪的吧？\n\n"
    "2\n-1:51:58,760 --> 00:01:58,300\n嘛 也是呢 确实是店长的本领\n\n"
    "3\n00:00:09,300 --> 00:00:15,660\n之前啊 我去大阪喝了一点 虽然不是很想喝\n\n"
)


def _cues(text: str) -> list[tuple[int, int]]:
    out = []
    for blk in text.strip().split("\n\n"):
        ts = [l for l in blk.split("\n") if "-->" in l][0]

        def ms(hms):
            h, m, s = hms.split(":")
            s, x = s.split(",")
            return (int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(x)

        a, b = ts.split(" --> ")
        out.append((ms(a), ms(b)))
    return out


def test_negative_start_clamped() -> None:
    new_text, fixed = sanitize_srt_text(EVIDENCE)
    assert fixed == 4, new_text  # 2 负值 clamp + 1 删长 cue + 1 重叠截断
    cues = _cues(new_text)
    assert cues == [(0, 9300), (9300, 15660)], cues
    assert "店长的本领" not in new_text  # 118s 长 cue（fallback 产物）被删
    assert "毕竟科长你啊" in new_text
    assert "1\n00:00:00,000 --> 00:00:09,300" in new_text
    print("  test_negative_start_clamped OK")


def test_valid_passthrough() -> None:
    valid = "1\n00:00:01,000 --> 00:00:02,000\n甲\n\n"
    out, fixed = sanitize_srt_text(valid)
    assert fixed == 0 and out == valid
    print("  test_valid_passthrough OK")


def test_bytes_and_garbage() -> None:
    out, fixed = sanitize_srt_bytes(EVIDENCE.encode("utf-8"))
    assert fixed == 4
    assert out.decode("utf-8").startswith("1\n00:00:00,000 --> 00:00:09,300")
    for bad in (b"", b"garbage", b"\xff\xfe\x00", ("1\n乱 --> 乱\nx\n\n").encode("utf-8")):
        data, fixed = sanitize_srt_bytes(bad)
        assert data == bad and fixed == 0, bad
    print("  test_bytes_and_garbage OK")


def test_sorted_renumbered() -> None:
    text = (
        "1\n00:00:10,000 --> 00:00:12,000\n乙\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\n甲\n\n"
    )
    new_text, fixed = sanitize_srt_text(text)
    cues = _cues(new_text)
    assert cues == [(1000, 2000), (10000, 12000)], cues
    assert new_text.index("甲") < new_text.index("乙")
    assert "1\n00:00:01,000" in new_text and "2\n00:00:10,000" in new_text
    print("  test_sorted_renumbered OK")


def test_long_covered_dropped() -> None:
    text = (
        "1\n00:00:10,000 --> 00:01:00,000\n长句\n\n"
        "2\n00:00:12,000 --> 00:00:15,000\n细A\n\n"
        "3\n00:00:16,000 --> 00:00:18,000\n细B\n\n"
    )
    new_text, fixed = sanitize_srt_text(text)
    assert fixed == 1, new_text
    assert _cues(new_text) == [(12000, 15000), (16000, 18000)]
    assert "长句" not in new_text and "细A" in new_text
    print("  test_long_covered_dropped OK")


def test_long_isolated_kept() -> None:
    text = (
        "1\n00:00:10,000 --> 00:00:50,000\n长独白\n\n"
        "2\n00:02:00,000 --> 00:02:05,000\n下一句\n\n"
    )
    new_text, fixed = sanitize_srt_text(text)
    assert fixed == 0 and new_text == text
    print("  test_long_isolated_kept OK")


def test_overlap_truncated() -> None:
    text = (
        "1\n00:00:10,000 --> 00:00:11,000\n甲\n\n"
        "2\n00:00:10,800 --> 00:00:12,000\n乙\n\n"
    )
    new_text, fixed = sanitize_srt_text(text)
    assert fixed == 1, new_text
    assert _cues(new_text) == [(10000, 10800), (10800, 12000)]
    print("  test_overlap_truncated OK")


def test_overlap_idempotent() -> None:
    text = EVIDENCE + "4\n00:02:00,000 --> 00:02:05,000\n丁\n\n"
    first, fixed1 = sanitize_srt_text(text)
    assert fixed1 == 4, first
    second, fixed2 = sanitize_srt_text(first)
    assert fixed2 == 0 and second == first
    print("  test_overlap_idempotent OK")


if __name__ == "__main__":
    test_negative_start_clamped()
    test_valid_passthrough()
    test_bytes_and_garbage()
    test_sorted_renumbered()
    test_long_covered_dropped()
    test_long_isolated_kept()
    test_overlap_truncated()
    test_overlap_idempotent()
    print("SANITIZER TESTS PASSED")
