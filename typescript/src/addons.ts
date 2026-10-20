/**
 * Default Firefox addon download/extraction.
 *
 * TypeScript twin of python/src/camoufox/addons.py.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { InvalidAddonPath } from "./exceptions.js";
import { INSTALL_DIR, loadDataFile } from "./paths.js";
import { unzip, verifySha256, webdl } from "./pkgman.js";

interface AddonPin {
	version: string;
	url: string;
	sha256: string;
}

const PINS: Record<string, AddonPin> = loadDataFile("addons.json");

/**
 * Default addons to be downloaded.
 */
export const DefaultAddons = {
	UBO: PINS.UBO.url,
} as const;

export type DefaultAddon = keyof typeof DefaultAddons;

// Addons are stored in a shared folder, not per-browser version
const ADDONS_DIR: string = path.join(INSTALL_DIR, "addons");

/**
 * Confirms that the addon paths are valid.
 */
export function confirmPaths(paths: string[]): void {
	for (const addonPath of paths) {
		if (!fs.existsSync(addonPath) || !fs.statSync(addonPath).isDirectory()) {
			throw new InvalidAddonPath(addonPath);
		}
		if (!fs.existsSync(path.join(addonPath, "manifest.json"))) {
			throw new InvalidAddonPath(
				"manifest.json is missing. Addon path must be a path to an extracted addon.",
			);
		}
	}
}

/**
 * Adds default addons, minus any specified in excludeList, to addonsList.
 */
export async function addDefaultAddons(
	addonsList: string[],
	excludeList: DefaultAddon[] = [],
): Promise<void> {
	const addons: Record<string, string> = {};
	for (const [name, url] of Object.entries(DefaultAddons)) {
		if (!excludeList.includes(name as DefaultAddon)) {
			addons[name] = url;
		}
	}
	await maybeDownloadAddons(addons, addonsList);
}

/**
 * Downloads and extracts an addon from a given URL to a specified path.
 */
export async function downloadAndExtract(
	url: string,
	extractPath: string,
	name: string,
): Promise<void> {
	const buffer = await webdl(url, `Downloading addon (${name})`, false);
	verifySha256(buffer, PINS[name].sha256, `addon (${name})`);
	unzip(buffer, extractPath, `Extracting addon (${name})`, false);
}

/**
 * Returns a path to the pinned version of the addon in the shared addons folder.
 */
export function getAddonPath(addonName: string): string {
	return path.join(ADDONS_DIR, addonName, PINS[addonName].version);
}

/** Seams the Python tests reach with monkeypatch. */
export const addonsDeps = {
	downloadAndExtract: (url: string, extractPath: string, name: string) =>
		downloadAndExtract(url, extractPath, name),
};

/**
 * Extracts an addon beside its cache path, then renames it into place, so a
 * concurrent launch sees either no addon or a complete one.
 */
async function installAddon(
	addonName: string,
	url: string,
	addonPath: string,
): Promise<void> {
	const staging = path.join(
		path.dirname(addonPath),
		`.${addonName}.${randomUUID()}.tmp`,
	);
	try {
		await addonsDeps.downloadAndExtract(url, staging, addonName);
		try {
			fs.renameSync(staging, addonPath);
		} catch {
			// Another launch finished first. A directory without a manifest is
			// left by an extraction an older release was killed in.
			if (fs.existsSync(path.join(addonPath, "manifest.json"))) return;
			fs.rmSync(addonPath, { recursive: true });
			fs.renameSync(staging, addonPath);
		}
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Downloads and extracts addons from a given map into the given list.
 * Skips downloading if the addon is already extracted.
 */
export async function maybeDownloadAddons(
	addons: Record<string, string>,
	addonsList?: string[],
): Promise<void> {
	for (const [addonName, url] of Object.entries(addons)) {
		const addonPath = getAddonPath(addonName);
		if (!fs.existsSync(path.join(addonPath, "manifest.json"))) {
			await installAddon(addonName, url, addonPath);
		}
		addonsList?.push(addonPath);
	}
}
