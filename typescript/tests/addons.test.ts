/**
 * Mirrors python/tests/test_addons.py: regression guard for #308, where a
 * failed first download left an empty addon directory that was trusted
 * forever afterwards, and for concurrent launches sharing a cold cache.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Addons = typeof import("../src/addons.js");

let tmp: string;
let savedXdg: string | undefined;
let addons: Addons;
let ubo: string;

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-addons-"));
	savedXdg = process.env.XDG_CACHE_HOME;
	// Point the addon store at a throwaway dir so no real cache is touched.
	process.env.XDG_CACHE_HOME = tmp;
	vi.resetModules();
	addons = await import("../src/addons.js");
	ubo = addons.getAddonPath("UBO");
	expect(ubo.startsWith(tmp)).toBe(true);
});

afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = savedXdg;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(extractPath: string) {
	fs.mkdirSync(extractPath, { recursive: true });
	fs.writeFileSync(path.join(extractPath, "manifest.json"), "{}");
}

it("re-downloads a partial (manifest-less) directory", async () => {
	// Left by an extraction that was killed before writing the manifest.
	fs.mkdirSync(ubo, { recursive: true });
	fs.writeFileSync(path.join(ubo, "background.js"), "");
	const calls: string[] = [];
	addons.addonsDeps.downloadAndExtract = async (_url, extractPath, name) => {
		calls.push(name);
		writeManifest(extractPath);
	};

	const out: string[] = [];
	await addons.maybeDownloadAddons({ ...addons.DefaultAddons }, out);

	expect(calls).toEqual(["UBO"]);
	expect(fs.existsSync(path.join(ubo, "manifest.json"))).toBe(true);
	expect(out).toEqual([ubo]);
});

it("does not re-download an extracted addon", async () => {
	writeManifest(ubo);
	addons.addonsDeps.downloadAndExtract = async () => {
		throw new Error("must not re-download an already-extracted addon");
	};

	const out: string[] = [];
	await addons.maybeDownloadAddons({ ...addons.DefaultAddons }, out);
	expect(out).toEqual([ubo]);
});

it("raises and leaves nothing behind when a download fails", async () => {
	addons.addonsDeps.downloadAndExtract = async (_url, extractPath) => {
		fs.mkdirSync(extractPath, { recursive: true }); // partial write, then die
		throw new Error("network died mid-download");
	};

	// Launching without the addon would be a different browser than asked for.
	await expect(
		addons.maybeDownloadAddons({ ...addons.DefaultAddons }, []),
	).rejects.toThrow("network died mid-download");
	const dir = path.dirname(ubo);
	expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
});

it("never hands a concurrent launch a half-extracted addon", async () => {
	// Parallel launches on a cold cache: one is still extracting when another
	// checks the cache. The second must not be handed that addon.
	let releaseFirst!: () => void;
	const firstBlocked = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	let calls = 0;
	addons.addonsDeps.downloadAndExtract = async (_url, extractPath) => {
		writeManifest(extractPath);
		if (calls++ === 0) {
			firstStarted();
			await firstBlocked;
		}
		fs.writeFileSync(path.join(extractPath, "background.js"), "");
	};

	const firstOut: string[] = [];
	const first = addons.maybeDownloadAddons(
		{ ...addons.DefaultAddons },
		firstOut,
	);
	await started;
	try {
		const secondOut: string[] = [];
		await addons.maybeDownloadAddons({ ...addons.DefaultAddons }, secondOut);
		expect(secondOut).toEqual([ubo]);
		expect(fs.existsSync(path.join(ubo, "background.js"))).toBe(true);
	} finally {
		releaseFirst();
		await first;
	}
	expect(firstOut).toEqual([ubo]);
	expect(fs.readdirSync(path.dirname(ubo))).toEqual([path.basename(ubo)]);
});

const PINS = JSON.parse(
	fs.readFileSync(
		path.join(import.meta.dirname, "../../python/src/camoufox/addons.json"),
		"utf-8",
	),
);

it("pins every default addon to one file", () => {
	for (const [name, url] of Object.entries(addons.DefaultAddons)) {
		const pin = PINS[name];
		expect(url).toBe(pin.url);
		expect(pin.url).toContain(`-${pin.version}.xpi`);
		expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
	}
});

it("caches each pinned version in its own directory", () => {
	// A cache filled by another release must not stand in for this one's pin.
	expect(ubo).toBe(
		path.join(tmp, "camoufox", "addons", "UBO", PINS.UBO.version),
	);
});

it("rejects a download that does not match the pin", async () => {
	vi.doMock("../src/pkgman.js", async (importOriginal) => ({
		...(await importOriginal<typeof import("../src/pkgman.js")>()),
		webdl: async () => Buffer.from("not the pinned xpi"),
	}));
	vi.resetModules();
	const mocked: Addons = await import("../src/addons.js");
	const { CorruptedDownload } = await import("../src/exceptions.js");

	try {
		await expect(
			mocked.maybeDownloadAddons({ ...mocked.DefaultAddons }, []),
		).rejects.toBeInstanceOf(CorruptedDownload);
		const dir = path.dirname(ubo);
		expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
	} finally {
		vi.doUnmock("../src/pkgman.js");
	}
});
