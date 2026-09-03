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
    assert fixed == 2, new_text
    cues = _cues(new_text)
    assert cues == [(0, 23880), (0, 118300), (9300, 15660)], cues
    assert "毕竟科长你啊" in new_text
    assert "1\n00:00:00,000 --> 00:00:23,880" in new_text
    print("  test_negative_start_clamped OK")


def test_valid_passthrough() -> None:
    valid = "1\n00:00:01,000 --> 00:00:02,000\n甲\n\n"
    out, fixed = sanitize_srt_text(valid)
    assert fixed == 0 and out == valid
    print("  test_valid_passthrough OK")


def test_bytes_and_garbage() -> None:
    out, fixed = sanitize_srt_bytes(EVIDENCE.encode("utf-8"))
    assert fixed == 2
    assert out.decode("utf-8").startswith("1\n00:00:00,000 --> 00:00:23,880")
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


if __name__ == "__main__":
    test_negative_start_clamped()
    test_valid_passthrough()
    test_bytes_and_garbage()
    test_sorted_renumbered()
    print("SANITIZER TESTS PASSED")
