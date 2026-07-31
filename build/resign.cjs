/**
 * Re-sign the app bundle after electron-builder has unpacked the native
 * inference binaries into it.
 *
 * electron-builder signs the bundle and *then* places `asarUnpack` content, so
 * the `.node` files and dylibs that node-llama-cpp dlopens land inside a signed
 * bundle without being covered by its signature. On arm64 macOS that is fatal
 * rather than untidy: the loader refuses the app as damaged
 * (electron-builder#5850).
 *
 * It matters twice over in this project, and the second reason is the one that
 * would be missed. `identity` is ad-hoc ("-"), and `selfupdate.ts` runs
 * `codesign --verify --deep --strict` on every downloaded bundle before
 * swapping it in. Without this hook a fresh install would still launch, and
 * every future self-update would refuse itself with no obvious cause.
 *
 * CommonJS on purpose — package.json has no `"type": "module"`, and
 * electron-builder requires this file directly.
 */

const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function resign(context) {
  // Only macOS gets an ad-hoc signature to repair; nothing else is built here
  // today, and silently re-signing on another platform would be a lie.
  if (context.electronPlatformName !== "darwin") return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  /*
   * --deep is deprecated by Apple for *signing* real distributions, and is
   * exactly right here: there is no Developer ID, no notarization, and no
   * entitlements to preserve — the goal is only that every nested binary
   * carries a valid ad-hoc signature so the loader will run it. --force is
   * required because the outer bundle is already signed.
   */
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });

  // Fail the build rather than ship a bundle that will be refused at launch or,
  // worse, only at the first self-update months later.
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`  • re-signed after asarUnpack  ${app}`);
};
