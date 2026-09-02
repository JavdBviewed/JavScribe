"""EngineStore: env preset parsing, idempotent merge, persistence, validation."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe_web.config import EngineStore, is_url, parse_engines_env  # noqa: E402


def test_parse_engines_env() -> None:
    assert parse_engines_env("a=http://10.0.0.1:8300,b=https://x:8300") == [
        ("a", "http://10.0.0.1:8300"),
        ("b", "https://x:8300"),
    ]
    # malformed parts ignored: no '=', bad scheme, empty
    assert parse_engines_env("a=ftp://x,badline,=http://y, ,c=http://c/") == [
        ("c", "http://c"),
    ]
    assert parse_engines_env("") == []


def test_is_url() -> None:
    assert is_url("http://127.0.0.1:8300")
    assert is_url("https://a.b/c")
    assert not is_url("ftp://x")
    assert not is_url("http://x y")
    assert not is_url("")


def test_env_merge_idempotent() -> None:
    os.environ["JAV_ENGINES"] = "one=http://10.0.0.1:8300,two=http://10.0.0.2:8300"
    try:
        with tempfile.TemporaryDirectory() as td:
            s1 = EngineStore(td)
            assert [e["name"] for e in s1.engines] == ["one", "two"]
            # trailing slash normalized
            assert s1.get("one")["url"] == "http://10.0.0.1:8300"
            # restart: file has the same entries + env again -> no dupes
            s2 = EngineStore(td)
            assert [e["name"] for e in s2.engines] == ["one", "two"]
    finally:
        os.environ.pop("JAV_ENGINES", None)


def test_add_remove_persist() -> None:
    os.environ.pop("JAV_ENGINES", None)
    with tempfile.TemporaryDirectory() as td:
        store = EngineStore(td)
        e = store.add("w", "http://10.9.9.9:8300/")
        assert e == {"name": "w", "url": "http://10.9.9.9:8300"}
        # same name same url = idempotent update
        assert store.add("w", "http://10.9.9.9:8300")["url"] == "http://10.9.9.9:8300"
        # same name different url = rejected
        assert store.add("w", "http://10.0.0.9:8300") is None
        # invalid name/url rejected
        assert store.add("", "http://x") is None
        assert store.add("x", "not a url") is None
        assert store.remove("nope") is False
        assert store.remove("w") is True
        # persistence round-trip
        store2 = EngineStore(td)
        assert store2.engines == []
        store2.add("v", "http://1.2.3.4:8300")
        assert EngineStore(td).get("v")["url"] == "http://1.2.3.4:8300"


def test_corrupt_registry_recovers() -> None:
    os.environ.pop("JAV_ENGINES", None)
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "engines.json").write_text("{not json", encoding="utf-8")
        store = EngineStore(td)
        assert store.engines == []
        assert store.add("a", "http://a:8300") is not None


if __name__ == "__main__":
    test_parse_engines_env()
    test_is_url()
    test_env_merge_idempotent()
    test_add_remove_persist()
    test_corrupt_registry_recovers()
    print("  test_config OK")
