/**
 * Whether there is room to load the model right now.
 *
 * The target machine has 8 GB and no way to get more. macOS will happily let a
 * 3.5 GB wired allocation succeed and then spend the next ten minutes swapping
 * everything else out around it, which on a fanless Air feels like the app has
 * broken. Saying "close some apps" before that happens is a better product than
 * any amount of recovery afterwards.
 */

import { execFileSync } from "node:child_process";

/**
 * Bytes macOS could hand over without pushing anything to swap.
 *
 * **`os.freemem()` is the wrong number here and it is worth saying why.** On
 * macOS it reports only pages on the free list — this machine reported 0.9 GB
 * free of 32 GB while sitting idle, because everything else is file cache and
 * inactive pages that the kernel will reclaim the instant anyone asks. Loading
 * a 3.5 GB model on that reading would refuse on a machine with 20 GB spare.
 *
 * What Activity Monitor treats as available, and what this uses, is the free
 * list plus the pages the kernel can take back for nothing: inactive,
 * speculative, and the purgeable share of them.
 *
 * Returns 0 when `vm_stat` cannot be read, which the caller treats as
 * "unknown, go ahead" — a memory check that blocks the feature because a
 * diagnostic tool moved would be worse than no check.
 */
export function availableMemory(): number {
  let out: string;
  try {
    out = execFileSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 2000 });
  } catch {
    return 0;
  }

  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
  const pages = (label: string): number =>
    Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(out)?.[1] ?? 0);

  const reclaimable =
    pages("Pages free") +
    pages("Pages inactive") +
    pages("Pages speculative") +
    pages("Pages purgeable");
  return reclaimable * pageSize;
}
