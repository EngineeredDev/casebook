/**
 * Asking GitHub whether there is a newer Casebook.
 *
 * Squirrel.Mac and electron-updater both refuse to run against an app that is
 * not signed by a real certificate, so this is hand-rolled. It works because of
 * one property of macOS: a file downloaded by Node carries no
 * com.apple.quarantine attribute, while anything Chromium downloads does. A
 * quarantined app gets run from a randomised read-only mount — App
 * Translocation — where it could not replace itself even in principle. So every
 * request here goes through Node's fetch, and none through `net.fetch` or the
 * session's download API, which route via Chromium.
 *
 * Trust model, stated plainly: nothing is verified. There is no certificate to
 * verify against and there is not going to be one. This trusts GitHub over
 * HTTPS, pinned to one repository. That is acceptable for a tool with one user
 * and would not be for anything wider.
 *
 * Revisited at review time (2026-08-02) and reaffirmed. Publishing SHA-256
 * checksums in the same GitHub release was considered and rejected: it adds
 * nothing against the threat that motivates it, since whoever can publish a
 * release can publish its checksums too, and the ad-hoc codesign check already
 * catches truncation and corruption. Real publisher authentication means
 * embedding a verification key in the app and signing releases in CI with a
 * managed secret — meaningful work plus key-management liability, for an app
 * whose fallback installer trusts exactly the same root. Revisit the moment
 * distribution widens beyond one user; artifact attestations are the
 * reasonable middle step if this repo ever has other consumers.
 */

import { app } from "electron";
import type { UpdateCheck, UpdateInfo } from "../shared/api.ts";

const REPO = "EngineeredDev/casebook";
const FEED = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET = "Casebook-mac-arm64.zip";

/**
 * `releases/latest` is the endpoint that ignores prereleases and drafts, which
 * is what keeps untagged CI builds from ever reaching her. See RELEASING.md.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Long enough to stay out of the way of opening the window. */
const FIRST_CHECK_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** The newest update found so far, so a window opening later can be told about it. */
let available: UpdateInfo | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function getAvailableUpdate(): UpdateInfo | null {
  return available;
}

/** Drop the leading v and any prerelease suffix, then split into numbers. */
function parseVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

/**
 * Numeric comparison, because the lexical one says 1.10.0 is older than 1.9.0
 * and would strand her one version back with no way to notice.
 *
 * Anything that doesn't parse is treated as "not newer". Refusing to offer an
 * update is a recoverable failure — the install script still works — where
 * offering a bad one is not.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a.length === 0 || a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface Release {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

function readRelease(raw: unknown, current: string): UpdateCheck {
  const release = raw as Release;
  const tag = typeof release.tag_name === "string" ? release.tag_name : null;
  if (!tag) return { error: "GitHub's answer didn't name a version." };

  const version = tag.replace(/^v/i, "");
  if (!isNewer(version, current)) return { available: false, version: current };

  const assets = Array.isArray(release.assets) ? (release.assets as ReleaseAsset[]) : [];
  const asset = assets.find((candidate) => candidate.name === ASSET);
  const downloadUrl =
    typeof asset?.browser_download_url === "string" ? asset.browser_download_url : null;
  if (!downloadUrl) {
    // A release with no Mac build is a release she cannot install. Saying so
    // beats offering an update whose download would 404 later.
    return { error: `Release ${version} has no ${ASSET} attached.` };
  }

  return {
    available: true,
    info: {
      version,
      downloadUrl,
      releaseUrl:
        typeof release.html_url === "string"
          ? release.html_url
          : `https://github.com/${REPO}/releases/latest`,
    },
  };
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion();
  let response: Response;
  try {
    response = await fetch(FEED, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub rejects API requests that don't identify themselves.
        "User-Agent": `Casebook/${current}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // No network is the ordinary case, not a fault: a school Mac may be behind
    // a proxy that refuses this, and none of it stops Casebook working.
    return { error: `Couldn't reach GitHub — ${(error as Error).message}` };
  }

  if (response.status === 404) {
    // No published release at all. True of a fresh repository, and true for as
    // long as everything on it is a prerelease.
    return { available: false, version: current };
  }
  if (!response.ok) return { error: `GitHub answered ${response.status}.` };

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    return { error: `GitHub's answer wasn't readable — ${(error as Error).message}` };
  }

  const result = readRelease(raw, current);
  if ("available" in result && result.available) available = result.info;
  return result;
}

/**
 * Check shortly after launch and every few hours after that. Failures are
 * swallowed: this runs unattended, and there is no version of "couldn't reach
 * GitHub" that is worth interrupting her about.
 */
export function startUpdateChecks(onFound: (info: UpdateInfo) => void): void {
  // A development build's version is whatever package.json currently says,
  // which has nothing to do with what is published.
  if (!app.isPackaged || timer) return;

  const run = () => {
    void checkForUpdate().then((result) => {
      if ("available" in result && result.available) onFound(result.info);
    });
  };

  setTimeout(run, FIRST_CHECK_DELAY_MS);
  timer = setInterval(run, CHECK_INTERVAL_MS);
}

export function stopUpdateChecks(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
