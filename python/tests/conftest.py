import pytest
import requests


@pytest.fixture(autouse=True)
def no_host_gpu_probe(monkeypatch):
    """launch_options launches the browser to read the host's GPU when an
    identity claims the host's OS. This suite has no browser, and its results
    must not depend on the machine running it, so the host reads as having no
    WebGL. Tests of the probe's consumers patch it themselves."""
    from camoufox import utils

    monkeypatch.setattr(utils, 'host_gpu', lambda *args: None)


@pytest.fixture
def github(monkeypatch):
    """Serve URLs from a dict (anything else is a 404), and record every request."""
    from camoufox import pkgman

    served, requested = {}, []

    class Response:
        def __init__(self, url):
            self.url = url
            self.status_code = 200 if url in served else 404

        def raise_for_status(self):
            if self.status_code != 200:
                raise requests.HTTPError(f"404 Client Error: Not Found for url: {self.url}", response=self)

        def json(self):
            return served[self.url]

    def get(url, **_kwargs):
        requested.append(url)
        return Response(url)

    monkeypatch.setattr(pkgman.requests, "get", get)
    monkeypatch.setattr(pkgman, "_release_interfaces", {})
    monkeypatch.setattr(pkgman, "OS_NAME", "lin")
    monkeypatch.setattr(pkgman.RepoConfig, "get_arch", lambda self, spoof_arch=None: spoof_arch or "x86_64")
    return served, requested
