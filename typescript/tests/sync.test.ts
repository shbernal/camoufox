/**
 * Mirrors python/tests/test_sync.py: `camoufox sync` never trades a good cache
 * for a failed listing.
 *
 * The CLI runs on import, so each test points XDG_CACHE_HOME at a fresh
 * directory, mocks the network, imports __main__, and waits for the summary.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const API = "https://api.github.com/repos/daijro/camoufox/releases";
const FALLBACK = "https://api.github.com/repos/camoufox/camoufox/releases";

let tmp: string;
let savedXdg: string | undefined;
let savedArgv: string[];
let served: Map<string, unknown>;
let requested: string[];
let output: string;

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-sync-"));
	savedXdg = process.env.XDG_CACHE_HOME;
	savedArgv = process.argv;
	process.env.XDG_CACHE_HOME = tmp;
	served = new Map();
	requested = [];
	vi.stubGlobal("fetch", async (url: string) => {
		requested.push(url);
		return served.has(url)
			? new Response(JSON.stringify(served.get(url)))
			: new Response("", { status: 404, statusText: "Not Found" });
	});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output += String(chunk);
		return true;
	});
});

afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = savedXdg;
	process.argv = savedArgv;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function release(build: string) {
	const { RepoConfig } = await import("../src/pkgman.js");
	const official = RepoConfig.getDefault();
	return {
		tag_name: `v156.0.1-${build}`,
		prerelease: false,
		assets: [
			{
				name: `camoufox-156.0.1-${build}-${official.getOsName()}.${official.getArch()}.zip`,
				browser_download_url: `https://example.invalid/${build}.zip`,
				created_at: "2026-10-01T00:00:00Z",
			},
		],
	};
}

/** Run `camoufox sync` with Official as the only source; returns its output. */
async function sync(...args: string[]): Promise<string> {
	vi.resetModules();
	const { RepoConfig } = await import("../src/pkgman.js");
	const official = RepoConfig.getDefault();
	vi.spyOn(RepoConfig, "loadRepos").mockReturnValue([official]);
	output = "";
	process.argv = ["node", "camoufox", "sync", ...args];
	await import("../src/__main__.js");
	await vi.waitFor(() => {
		if (!output.includes("\nSynced ")) throw new Error("sync is still running");
	});
	return output;
}

async function cachedBuilds(): Promise<string[]> {
	const { loadRepoCache } = await import("../src/multiversion.js");
	return (loadRepoCache().repos ?? []).flatMap((repo) =>
		(repo.versions ?? []).map((v) => v.build),
	);
}

it("keeps the cached versions when a listing fails", async () => {
	served.set(API, [await release("beta.36")]);
	await sync();

	served.clear();
	const out = await sync();

	expect(out).toContain("Error: 404");
	expect(await cachedBuilds()).toEqual(["beta.36"]);
});

it("keeps nothing when a listing for another platform fails", async () => {
	served.set(API, [await release("beta.36")]);
	await sync();

	served.clear();
	await sync("--spoof-os", "win", "--spoof-arch", "x86_64");

	expect(await cachedBuilds()).toEqual([]);
});

it("retries an empty listing", async () => {
	const listed = [await release("beta.36")];
	vi.stubGlobal("fetch", async (url: string) => {
		requested.push(url);
		const body = requested.filter((u) => u === API).length > 1 ? listed : [];
		return new Response(JSON.stringify(body));
	});

	await sync();

	expect(requested).toEqual([API, API]);
	expect(await cachedBuilds()).toEqual(["beta.36"]);
});

it("treats an empty listing as a failure", async () => {
	served.set(API, [await release("beta.36")]);
	await sync();

	served.set(API, []);
	const out = await sync();

	expect(out).toContain("listed no releases");
	expect(await cachedBuilds()).toEqual(["beta.36"]);
});

it("reports the first repo's error", async () => {
	vi.stubGlobal("fetch", async (url: string) =>
		url === API
			? new Response("", { status: 403, statusText: "rate limit exceeded" })
			: new Response("", { status: 404, statusText: "Not Found" }),
	);

	const out = await sync();

	expect(out).toContain("403");
	expect(out).not.toContain(FALLBACK);
});
