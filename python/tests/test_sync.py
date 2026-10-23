"""`camoufox sync` never trades a good cache for a failed listing.

A source whose release listing fails keeps its previous cache entry, so one
failed request (a rate limit, an outage) no longer leaves `fetch` with nothing
to install. GitHub sometimes answers `GET /releases` with 200 and an empty
list; that is retried once and then treated as a failure, not as a source with
no releases. When every repo of a source fails, the error reported is the
first repo's, not the fallback's.
"""

import json

import pytest
import requests
from click.testing import CliRunner

from camoufox import __main__ as cli
from camoufox import multiversion, pkgman

API = "https://api.github.com/repos/daijro/camoufox/releases"
FALLBACK = "https://api.github.com/repos/camoufox/camoufox/releases"


@pytest.fixture
def cache(tmp_path, monkeypatch):
    """The repo cache, in a temporary directory, with Official as the only source."""
    official = pkgman.RepoConfig.get_default()
    monkeypatch.setattr(pkgman.RepoConfig, "load_repos", staticmethod(lambda: [official]))
    monkeypatch.setattr(multiversion, "INSTALL_DIR", tmp_path)
    monkeypatch.setattr(multiversion, "REPO_CACHE_FILE", tmp_path / "repo_cache.json")
    return tmp_path / "repo_cache.json"


def _release(build):
    return {
        "tag_name": f"v156.0.1-{build}",
        "prerelease": False,
        "assets": [{
            "name": f"camoufox-156.0.1-{build}-lin.x86_64.zip",
            "browser_download_url": f"https://example.invalid/{build}.zip",
            "created_at": "2026-10-01T00:00:00Z",
        }],
    }


def _builds(cache_file):
    return [
        v["build"]
        for repo in json.loads(cache_file.read_text())["repos"]
        for v in repo["versions"]
    ]


def _sync():
    result = CliRunner().invoke(cli.cli, ["sync"])
    assert result.exit_code == 0, result.output
    return result.output


def test_a_failed_listing_keeps_the_cached_versions(github, cache):
    served, _ = github
    served[API] = [_release("beta.36")]
    _sync()

    served.clear()
    output = _sync()

    assert "Error: 404" in output
    assert _builds(cache) == ["beta.36"]


def test_a_failed_listing_for_another_platform_keeps_nothing(github, cache):
    served, _ = github
    served[API] = [_release("beta.36")]
    _sync()

    served.clear()
    CliRunner().invoke(cli.cli, ["sync", "--spoof-os", "win", "--spoof-arch", "x86_64"])

    assert _builds(cache) == []


def test_an_empty_listing_is_retried(github, cache, monkeypatch):
    served, requested = github
    serve = pkgman.requests.get

    def empty_once(url, **kwargs):
        served[API] = [_release("beta.36")] if url in requested else []
        return serve(url, **kwargs)

    monkeypatch.setattr(pkgman.requests, "get", empty_once)

    _sync()

    assert requested == [API, API]
    assert _builds(cache) == ["beta.36"]


def test_an_empty_listing_is_a_failure(github, cache):
    served, _ = github
    served[API] = [_release("beta.36")]
    _sync()

    served[API] = []
    output = _sync()

    assert "listed no releases" in output
    assert _builds(cache) == ["beta.36"]


def test_the_first_repos_error_is_reported(github, cache, monkeypatch):
    def limited(url, **_kwargs):
        response = requests.Response()
        response.status_code, response.url = (403, url) if url == API else (404, url)
        response.reason = "rate limit exceeded" if url == API else "Not Found"
        return response

    monkeypatch.setattr(pkgman.requests, "get", limited)

    output = _sync()

    assert "403" in output
    assert FALLBACK not in output
