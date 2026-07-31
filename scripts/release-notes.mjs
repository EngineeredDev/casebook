#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section for a version, for `gh release create
 * --notes-file`.
 *
 * This replaces `--generate-notes`, which looked like it was doing the job and
 * was not: GitHub's generator enumerates merged pull requests, and this repo
 * commits straight to main. v0.1.0 published with a body one line long.
 *
 * It exits non-zero rather than printing something empty, because the failure
 * being guarded against is a release that publishes with no notes at all —
 * which is silent, permanent for that tag, and exactly what happened before.
 * Failing the workflow costs a re-tag; publishing an empty release costs the
 * only description those users will ever be offered.
 *
 * Usage: node scripts/release-notes.mjs 1.2.0
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHANGELOG = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

/**
 * Everything under `## [version]` up to the next `## ` heading, with the
 * heading line itself dropped — the release title already says the version,
 * and repeating it as the first line of the body reads like a mistake.
 */
export function sectionFor(markdown, version) {
  const lines = markdown.split("\n");
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * The `[1.2.0]: https://...` definition at the foot of the file. Reusing it is
 * what keeps the compare link working without the workflow needing tags in the
 * checkout — `actions/checkout` fetches none by default, so deriving the
 * previous tag with git would work on a maintainer's machine and produce an
 * empty link in CI.
 */
export function compareLinkFor(markdown, version) {
  const match = markdown.match(new RegExp(`^\\[${version}\\]:\\s*(\\S+)`, "m"));
  return match ? match[1] : null;
}

function main() {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write("Usage: node scripts/release-notes.mjs <version>\n");
    process.exit(2);
  }

  const markdown = readFileSync(CHANGELOG, "utf8");
  const body = sectionFor(markdown, version);
  if (body === null) {
    process.stderr.write(
      `::error::CHANGELOG.md has no content under "## [${version}]".\n` +
        "A release publishes that section as its notes, and an empty one cannot be\n" +
        "fixed for anyone who already read it. Write the section, then re-tag.\n" +
        "See RELEASING.md.\n",
    );
    process.exit(1);
  }

  const link = compareLinkFor(markdown, version);
  process.stdout.write(link ? `${body}\n\n**Full Changelog**: ${link}\n` : `${body}\n`);
}

// Importable for testing, runnable as a script — the same shape as llm-eval.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
