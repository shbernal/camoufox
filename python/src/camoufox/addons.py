import json
import os
import shutil
import uuid
from enum import Enum
from pathlib import Path
from typing import List, Optional

from .exceptions import InvalidAddonPath
from .pkgman import INSTALL_DIR, unzip, verify_sha256, webdl

# Addons are stored in a shared folder, not per-browser version
ADDONS_DIR = INSTALL_DIR / "addons"

PINS = json.loads((Path(__file__).parent / 'addons.json').read_text(encoding='utf-8'))


class DefaultAddons(Enum):
    """
    Default addons to be downloaded
    """

    UBO = PINS['UBO']['url']


def confirm_paths(paths: List[str]) -> None:
    """
    Confirms that the addon paths are valid
    """
    for path in paths:
        if not os.path.isdir(path):
            raise InvalidAddonPath(path)
        if not os.path.exists(os.path.join(path, 'manifest.json')):
            raise InvalidAddonPath(
                'manifest.json is missing. Addon path must be a path to an extracted addon.'
            )


def add_default_addons(
    addons_list: List[str], exclude_list: Optional[List[DefaultAddons]] = None
) -> None:
    """
    Adds default addons, minus any specified in exclude_list, to addons_list
    """
    # Build a dictionary from DefaultAddons, excluding keys found in exclude_list
    if exclude_list is None:
        exclude_list = []

    addons = [addon for addon in DefaultAddons if addon not in exclude_list]
    maybe_download_addons(addons, addons_list)


def download_and_extract(url: str, extract_path: str, name: str) -> None:
    """
    Downloads and extracts an addon from a given URL to a specified path
    """
    # Create a temporary file to store the downloaded zip
    buffer = webdl(url, desc=f"Downloading addon ({name})", bar=False)
    verify_sha256(buffer, PINS[name]['sha256'], f"addon ({name})")
    unzip(buffer, extract_path, f"Extracting addon ({name})", bar=False)


def get_addon_path(addon_name: str) -> str:
    """
    Returns a path to the pinned version of the addon in the shared addons folder.
    """
    return str(ADDONS_DIR / addon_name / PINS[addon_name]['version'])


def install_addon(addon: DefaultAddons, addon_path: str) -> None:
    """
    Extracts an addon beside its cache path, then renames it into place, so a
    concurrent launch sees either no addon or a complete one.
    """
    staging = os.path.join(os.path.dirname(addon_path), f".{addon.name}.{uuid.uuid4().hex}.tmp")
    try:
        download_and_extract(addon.value, staging, addon.name)
        try:
            os.rename(staging, addon_path)
        except OSError:
            # Another launch finished first. A directory without a manifest is
            # left by an extraction an older release was killed in.
            if os.path.exists(os.path.join(addon_path, 'manifest.json')):
                return
            shutil.rmtree(addon_path)
            os.rename(staging, addon_path)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def maybe_download_addons(
    addons: List[DefaultAddons], addons_list: Optional[List[str]] = None
) -> None:
    """
    Downloads and extracts the given addons, adding their paths to addons_list.
    Skips downloading if the addon is already extracted.
    """
    for addon in addons:
        addon_path = get_addon_path(addon.name)
        if not os.path.exists(os.path.join(addon_path, 'manifest.json')):
            install_addon(addon, addon_path)
        if addons_list is not None:
            addons_list.append(addon_path)
