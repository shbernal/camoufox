"""
Tests for camoufox.addons default-addon download/caching.

Regression guard for #308: a partial/failed first download leaves an empty
addon directory behind. The old "already downloaded" check was a bare
os.path.exists(dir), so that empty dir was trusted forever and every later
launch raised InvalidAddonPath ("manifest.json is missing"), unrecoverable
short of manually deleting the cache. Also guards concurrent launches sharing a
cold cache, which extracted into the same directory at once.

Run with:
    cd python && python -m pytest tests/test_addons.py -v
"""

import os
import re
import threading
from io import BytesIO
from pathlib import Path

import pytest

from camoufox import addons as addons_mod
from camoufox.addons import DefaultAddons, maybe_download_addons
from camoufox.exceptions import CorruptedDownload

UBO = DefaultAddons.UBO.name


@pytest.fixture
def addons_dir(tmp_path, monkeypatch):
    # Point the addon store at a throwaway dir so no real cache is touched.
    root = tmp_path / "addons"
    monkeypatch.setattr(addons_mod, "get_addon_path", lambda name: str(root / name))
    return root


def _write_manifest(url, extract_path, name):
    os.makedirs(extract_path, exist_ok=True)
    with open(os.path.join(extract_path, "manifest.json"), "w") as f:
        f.write("{}")


def test_partial_dir_is_redownloaded(addons_dir, monkeypatch):
    # Leftover from an extraction that was killed before writing the manifest.
    partial = addons_dir / UBO
    partial.mkdir(parents=True)
    (partial / "background.js").write_text("")
    assert not (partial / "manifest.json").exists()

    calls = []

    def fake(url, extract_path, name):
        calls.append(name)
        _write_manifest(url, extract_path, name)

    monkeypatch.setattr(addons_mod, "download_and_extract", fake)

    out = []
    maybe_download_addons([DefaultAddons.UBO], out)

    # A manifest-less dir must trigger a re-download, not be trusted.
    assert calls == [UBO]
    assert (partial / "manifest.json").exists()
    assert out == [str(partial)]


def test_extracted_addon_is_not_redownloaded(addons_dir, monkeypatch):
    path = addons_dir / UBO
    path.mkdir(parents=True)
    (path / "manifest.json").write_text("{}")

    def boom(*a, **k):
        raise AssertionError("must not re-download an already-extracted addon")

    monkeypatch.setattr(addons_mod, "download_and_extract", boom)

    out = []
    maybe_download_addons([DefaultAddons.UBO], out)
    assert out == [str(path)]


def test_failed_download_raises_and_leaves_nothing(addons_dir, monkeypatch):
    def fail(url, extract_path, name):
        os.makedirs(extract_path, exist_ok=True)  # partial write, then die
        raise RuntimeError("network died mid-download")

    monkeypatch.setattr(addons_mod, "download_and_extract", fail)

    # Launching without the addon would be a different browser than asked for.
    with pytest.raises(RuntimeError, match="network died"):
        maybe_download_addons([DefaultAddons.UBO], [])
    assert not addons_dir.exists() or not any(addons_dir.iterdir())

def test_concurrent_launch_never_sees_a_half_extracted_addon(addons_dir, monkeypatch):
    # Parallel workers launching on a cold cache: one is still extracting when
    # another checks the cache. The second must not be handed that addon.
    path = addons_dir / UBO
    first_started, release_first = threading.Event(), threading.Event()

    def slow_then_fast(url, extract_path, name):
        os.makedirs(extract_path, exist_ok=True)
        (Path(extract_path) / "manifest.json").write_text("{}")
        if not first_started.is_set():
            first_started.set()
            release_first.wait()
        (Path(extract_path) / "background.js").write_text("")

    monkeypatch.setattr(addons_mod, "download_and_extract", slow_then_fast)

    first_out = []
    first = threading.Thread(
        target=maybe_download_addons, args=([DefaultAddons.UBO], first_out)
    )
    first.start()
    first_started.wait()

    second_out = []
    maybe_download_addons([DefaultAddons.UBO], second_out)
    assert second_out == [str(path)]
    assert (path / "background.js").exists()

    release_first.set()
    first.join()
    assert first_out == [str(path)]
    assert sorted(p.name for p in addons_dir.iterdir()) == [UBO]


def test_default_addons_are_pinned_to_one_file():
    for addon in DefaultAddons:
        pin = addons_mod.PINS[addon.name]
        assert addon.value == pin["url"]
        assert f"-{pin['version']}.xpi" in pin["url"]
        assert re.fullmatch(r"[0-9a-f]{64}", pin["sha256"])


def test_each_pinned_version_has_its_own_cache_dir():
    # A cache filled by another release must not stand in for this one's pin.
    pin = addons_mod.PINS[UBO]
    assert Path(addons_mod.get_addon_path(UBO)) == addons_mod.ADDONS_DIR / UBO / pin["version"]


def test_download_that_does_not_match_the_pin_is_rejected(addons_dir, monkeypatch):
    monkeypatch.setattr(addons_mod, "webdl", lambda *a, **k: BytesIO(b"not the pinned xpi"))

    with pytest.raises(CorruptedDownload):
        maybe_download_addons([DefaultAddons.UBO], [])
    assert not addons_dir.exists() or not any(addons_dir.iterdir())
