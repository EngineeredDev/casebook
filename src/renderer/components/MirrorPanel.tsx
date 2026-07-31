import { useState } from "react";
import { Alert, Button, Card, Code, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconCloudUpload,
  IconFolderPlus,
  IconFolderSymlink,
} from "@tabler/icons-react";
import type { MirrorState, MirrorTrouble } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { describeElapsed } from "../lib/snapshots.ts";

/**
 * Why a copy didn't happen, in sentences someone can act on — or decide not to,
 * which is usually the right answer. Each one says what is still true as well as
 * what went wrong, because every case here is survivable and none of them means
 * anything has been lost.
 */
const TROUBLE: Record<MirrorTrouble, string> = {
  unreachable:
    "That folder isn't there at the moment — the drive is unplugged, or the share isn't mounted. Casebook will copy everything across the next time it finds it.",
  denied:
    "Casebook isn't allowed to write to that folder. Choosing it again from here is usually enough to be granted access; otherwise check the folder's permissions, or pick a different one.",
  full: "There's no space left where that folder is. Casebook will pick up where it stopped once there's room.",
  unknown:
    "Casebook couldn't finish copying there the last time it tried. It'll try again on its own, and whatever is already in the folder is untouched.",
};

type Action = "copying" | "choosing" | "stopping";

/**
 * The copy that isn't on this Mac.
 *
 * Backups in the data folder survive a mistake; they don't survive the laptop
 * being stolen or its disk dying, because they're inside the thing being lost.
 * This is the panel that closes that gap, and its whole tone follows from the
 * mirror being a bonus copy rather than a dependency: an unplugged drive is an
 * ordinary Tuesday, not a failure, and it must never be dressed as one.
 */
export function MirrorPanel({
  mirror,
  onChange,
}: {
  /** Null until the first read comes back. */
  mirror: MirrorState | null;
  /**
   * Every call here hands back the state it produced, which is better than a
   * re-read: `setMirrorFolder` starts a copy in the background, so a fresh
   * `getBackups()` would be racing the very pass it wants to report on.
   */
  onChange: (next: MirrorState) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [askingToStop, setAskingToStop] = useState(false);
  const busy = action !== null;

  /**
   * One place for "did that work", because the answer is never a failure. A
   * pass that found nowhere to write has left the backups on this Mac exactly
   * as they were, so the second heading says what is waiting rather than what
   * went wrong — and the two callers need different ones, since being told
   * "nothing was copied" is no way to learn that a folder was set up at all.
   */
  const report = (next: MirrorState, done: { title: string; message: string }, waiting: string) => {
    notifications.show(
      next.trouble
        ? { color: "yellow", title: waiting, message: TROUBLE[next.trouble] }
        : { color: "teal", ...done },
    );
  };

  const choose = async () => {
    setAction("choosing");
    try {
      const picked = await api().chooseMirrorFolder();
      if (!picked) return;
      onChange(await api().setMirrorFolder(picked));
      // Pointing the mirror at a folder already starts a pass, and that pass
      // reports to nobody. Waiting on one here is what makes the panel show a
      // real file count straight away rather than the zero it was configured
      // with, which reads exactly like nothing happened.
      const next = await api().syncMirrorNow();
      onChange(next);
      report(
        next,
        {
          title: "Casebook is keeping a second copy there",
          message: `${describeFiles(next.fileCount)} copied across. New backups go there as they're made.`,
        },
        "That folder is set up, but isn't there right now",
      );
    } catch (error) {
      notifications.show({
        color: "yellow",
        title: "That folder isn't set up",
        message: `${bridgeMessage(error)} Your backups on this Mac are unaffected.`,
      });
    } finally {
      setAction(null);
    }
  };

  const copyNow = async () => {
    setAction("copying");
    try {
      const next = await api().syncMirrorNow();
      onChange(next);
      report(
        next,
        {
          title: "The second copy is up to date",
          message: `That folder now holds ${describeFiles(next.fileCount)}.`,
        },
        "Nothing was copied just now",
      );
    } catch (error) {
      notifications.show({
        color: "yellow",
        title: "Nothing was copied just now",
        message: `${bridgeMessage(error)} Your backups on this Mac are unaffected.`,
      });
    } finally {
      setAction(null);
    }
  };

  const stop = async () => {
    setAction("stopping");
    try {
      onChange(await api().setMirrorFolder(null));
      setAskingToStop(false);
      notifications.show({
        title: "Casebook has stopped copying",
        message: "The copies already in that folder are still there — nothing was removed.",
      });
    } catch (error) {
      notifications.show({
        color: "yellow",
        title: "That didn't take effect",
        message: bridgeMessage(error),
      });
    } finally {
      setAction(null);
    }
  };

  return (
    <Card>
      <Text fw={600}>A second copy</Text>
      <Text size="xs" c="dimmed" mt={2} mb="sm">
        Backups in your data folder survive a mistake. They don't survive the Mac. Casebook can put
        a copy of every backup in a second folder — on an external drive, a network share, or one a
        cloud service keeps in sync — and top it up as new backups are made.
      </Text>

      {mirror === null ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Looking…
          </Text>
        </Group>
      ) : mirror.dir === null ? (
        <>
          <Text size="sm">
            There's no second copy yet, so everything Casebook holds is in one folder on this
            computer.
          </Text>
          <Button
            variant="default"
            leftSection={<IconFolderPlus size={16} />}
            onClick={() => void choose()}
            loading={action === "choosing"}
            mt="sm"
          >
            Choose a folder…
          </Button>
        </>
      ) : (
        <Stack gap="sm">
          <Code block>{mirror.dir}</Code>

          <Text size="xs" c="dimmed">
            {mirror.lastSuccessAt
              ? `Last copied ${describeElapsed(mirror.lastSuccessAt)} · ${describeFiles(mirror.fileCount)} there`
              : "Nothing has been copied there yet."}
          </Text>

          <Trouble mirror={mirror} />

          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconCloudUpload size={16} />}
              onClick={() => void copyNow()}
              loading={action === "copying"}
              disabled={busy}
            >
              Copy now
            </Button>
            <Button
              variant="default"
              leftSection={<IconFolderSymlink size={16} />}
              onClick={() => void choose()}
              loading={action === "choosing"}
              disabled={busy}
            >
              Change folder…
            </Button>
            <Button
              variant="subtle"
              color="gray"
              onClick={() => setAskingToStop(true)}
              disabled={busy}
            >
              Stop copying
            </Button>
          </Group>

          <Modal
            opened={askingToStop}
            onClose={() => setAskingToStop(false)}
            title="Stop keeping a second copy?"
            centered
          >
            <Stack gap="sm">
              <Text size="sm">
                Casebook will stop copying new backups to that folder. Everything already there
                stays exactly where it is — this doesn't delete anything.
              </Text>
              <Text size="sm" c="dimmed">
                You can point Casebook at a folder again whenever you like, and it'll fill in
                whatever it missed in the meantime.
              </Text>
              <Group justify="flex-end" gap="xs" mt="xs">
                <Button
                  variant="default"
                  onClick={() => setAskingToStop(false)}
                  disabled={action === "stopping"}
                >
                  Keep copying
                </Button>
                <Button onClick={() => void stop()} loading={action === "stopping"}>
                  Stop copying
                </Button>
              </Group>
            </Stack>
          </Modal>
        </Stack>
      )}

      <Text size="xs" c="dimmed" mt="md">
        Only the backups are copied, never the live file — a file that changes every few seconds is
        how sync services end up making "conflicted copy" duplicates. And if a cloud service keeps
        that folder in sync, deleting files there deletes them everywhere it reaches: that's the
        service's rules, not Casebook's.
      </Text>
    </Card>
  );
}

/**
 * The mirror's bad news, at the volume it actually deserves.
 *
 * A drive that's at home on the kitchen table is the ordinary case, not a
 * failure, and it gets one dimmed line. Only a week of not managing a single
 * copy earns a coloured box — and even that one is yellow, says what is still
 * true, and asks for nothing. Nothing in this panel is ever red and nothing in
 * it ever blocks: it is a second copy, and treating an unplugged drive as an
 * emergency would teach her to ignore the one warning that will matter.
 */
function Trouble({ mirror }: { mirror: MirrorState }) {
  if (mirror.stale) {
    return (
      <Alert
        variant="light"
        color="yellow"
        icon={<IconAlertTriangle size={18} />}
        title="The second copy is over a week behind"
      >
        <Text size="xs">
          {mirror.trouble ? `${TROUBLE[mirror.trouble]} ` : ""}
          Your backups on this Mac are up to date and nothing has been lost — it's only the copy in
          the other folder that's waiting. It'll catch up on its own once that folder is there
          again.
        </Text>
      </Alert>
    );
  }
  if (!mirror.trouble) return null;
  return (
    <Text size="xs" c="dimmed">
      {TROUBLE[mirror.trouble]}
    </Text>
  );
}

function describeFiles(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}
