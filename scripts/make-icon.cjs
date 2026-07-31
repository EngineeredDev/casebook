/**
 * Rasterize build/icon.svg into build/icon.icns.
 *
 *   npx electron scripts/make-icon.cjs
 *
 * Electron does the rendering because Electron is already here: it bundles the
 * same Chromium that draws the SVG in the app, so the icon and the mark in the
 * header can't disagree about what the artwork looks like. Adding a rasterizer
 * as a dependency to produce one committed file would be a poor trade. sips and
 * iconutil are macOS built-ins, and this project is macOS-only.
 *
 * CommonJS on purpose: Electron hangs indefinitely on an ESM entry point passed
 * as a bare path, with no error to explain itself.
 *
 * The .icns is committed, so this only needs running when the mark changes.
 */

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const source = join(root, "build", "icon.svg");
const iconset = join(root, "build", "icon.iconset");
const capture = join(root, "build", "icon-capture.png");

/**
 * Every size macOS asks for, under the names iconutil expects.
 *
 * All ten are resampled from the capture rather than any of them being the
 * capture itself: on a Retina display capturePage returns a 2048px image for a
 * 1024px window, and iconutil drops a mis-sized member of an iconset without
 * saying a word — which is a 1024px icon quietly missing from the .icns.
 */
const SIZES = [
  ["icon_16x16", 16],
  ["icon_16x16@2x", 32],
  ["icon_32x32", 32],
  ["icon_32x32@2x", 64],
  ["icon_128x128", 128],
  ["icon_128x128@2x", 256],
  ["icon_256x256", 256],
  ["icon_256x256@2x", 512],
  ["icon_512x512", 512],
  ["icon_512x512@2x", 1024],
];

async function main() {
  await app.whenReady();

  // Transparent, because the corners outside the squircle have to stay that
  // way. Never shown: paintWhenInitiallyHidden — on by default — means a hidden
  // window still renders, which is all capturePage needs. (Offscreen rendering
  // looks like the obvious tool here and is not: paired with transparency it
  // never delivers a frame at all.)
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
  });

  // The SVG is inlined into a page rather than loaded as a file, so the margins
  // a browser puts around a standalone image can't creep into the capture.
  const svg = readFileSync(source, "utf8");
  const page = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;width:1024px;height:1024px;overflow:hidden}
svg{display:block}</style>${svg}`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);

  // loadURL resolves when the document has loaded, which is a moment before the
  // compositor has anything to hand over. A frame of slack turns an
  // intermittently blank capture into a reliable one.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();

  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  writeFileSync(capture, image.toPNG());

  for (const [name, pixels] of SIZES) {
    const out = join(iconset, `${name}.png`);
    execFileSync("sips", ["-z", String(pixels), String(pixels), capture, "--out", out], {
      stdio: "ignore",
    });
  }

  const icns = join(root, "build", "icon.icns");
  execFileSync("iconutil", ["--convert", "icns", iconset, "--output", icns]);
  rmSync(iconset, { recursive: true, force: true });
  rmSync(capture, { force: true });

  // iconutil says nothing about members it rejected, so unpack the result and
  // count. This is the check that would have caught the 1024 going missing.
  execFileSync("iconutil", ["--convert", "iconset", icns, "--output", iconset]);
  const found = readdirSync(iconset).length;
  rmSync(iconset, { recursive: true, force: true });
  if (found !== SIZES.length) {
    throw new Error(`Expected ${SIZES.length} sizes in the .icns, found ${found}.`);
  }

  console.log(`Wrote ${icns}`);
}

main().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
