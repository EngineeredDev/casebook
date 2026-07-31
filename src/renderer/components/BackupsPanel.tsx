import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFolderOpen, IconListCheck, IconLock } from "@tabler/icons-react";
import type { BackupsState, SnapshotSummary } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { describeSnapshot } from "../lib/snapshots.ts";

/**
 * How many rows are worth reading before the list becomes something to scroll
 * past. Sixty days of daily snapshots on top of two years of monthly ones is
 * around two hundred files, and the one she wants is almost always in the first
 * few — a restore is nearly always undoing something that happened this
 * morning. The rest are there for the day that isn't true, behind one click.
 */
const VISIBLE = 15;

/**
 * The backups, and the two things worth doing to them.
 *
 * This panel is read on a bad morning or not at all, so it is written for the
 * bad morning: every row says when it was taken and how much is in it, because
 * "which one do I want" is the only question anybody brings here, and a
 * filename has never answered it.
 */
export function BackupsPanel({
  state,
  onRefresh,
  onRestored,
}: {
  /** Null until the first read comes back. */
  state: BackupsState | null;
  /** Re-read the list, after something here has changed what's in the folder. */
  onRefresh: () => void;
  /**
   * A restore replaces the document the rest of the app is holding a copy of.
   * Whoever owns that copy has to hear about it, or the next keystroke saves
   * the pre-restore document straight back over what was just restored.
   */
  onRestored: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  /** The row a confirmation is open for. Null means no dialog. */
  const [confirming, setConfirming] = useState<SnapshotSummary | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [checking, setChecking] = useState(false);

  const snapshots = state?.snapshots ?? [];
  const shown = expanded ? snapshots : snapshots.slice(0, VISIBLE);

  const restore = async (snapshot: SnapshotSummary) => {
    setRestoring(true);
    try {
      const result = await api().restoreSnapshot(snapshot.name);
      if ("error" in result) {
        notifications.show({
          color: "red",
          title: "Nothing was restored",
          message: `${result.error} Your data is exactly as it was.`,
          autoClose: false,
        });
        return;
      }
      onRestored();
      notifications.show({
        color: "teal",
        title: "Restored",
        message: result.preserved
          ? `Casebook is showing the backup from ${describeSnapshot(snapshot.takenAt)}. The file that wouldn't open was kept in your backups folder rather than replaced.`
          : `Casebook is showing the backup from ${describeSnapshot(snapshot.takenAt)}. What was here before is now the newest backup in this list, if you want it back.`,
        autoClose: false,
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Nothing was restored",
        message: `${bridgeMessage(error)} Your data is exactly as it was.`,
        autoClose: false,
      });
    } finally {
      setRestoring(false);
      setConfirming(null);
    }
  };

  /**
   * Reads every snapshot rather than trusting that they are fine. The point is
   * the renaming it does on the way: a damaged file found now is one the
   * recovery scan doesn't have to trip over at the moment it is most needed.
   */
  const check = async () => {
    setChecking(true);
    try {
      const result = await api().checkBackups();
      onRefresh();
      if (result.checked === 0) {
        notifications.show({
          title: "There's nothing to check yet",
          message: "Casebook takes its first backup the next time you change something.",
        });
        return;
      }
      if (result.unreadable.length === 0) {
        notifications.show({
          color: "teal",
          title: `Checked ${result.checked} backups — all readable`,
          message: "Every one of them opened cleanly.",
        });
        return;
      }
      // Yellow and not red, deliberately. Backups that don't open are worth
      // knowing about, but the ones that do are still there and still hold her
      // work — which is the fact this notification has to leave behind.
      notifications.show({
        color: "yellow",
        title: `${result.unreadable.length} of ${result.checked} backups couldn't be opened`,
        message:
          "They've been renamed so Casebook skips them from now on instead of stopping on them when it needs a backup in a hurry. Nothing was deleted, and the rest opened cleanly.",
        autoClose: false,
      });
    } catch (error) {
      notifications.show({
        color: "yellow",
        title: "Couldn't check your backups",
        message: `${bridgeMessage(error)} The backups themselves haven't been touched.`,
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card>
      <Text fw={600}>Backups</Text>
      <Text size="xs" c="dimmed" mt={2} mb="sm">
        Casebook keeps the version it's replacing every time it saves, and takes a full snapshot at
        most once every fifteen minutes while you're working. One a day is kept for sixty days, and
        the first of each month for two years.
      </Text>

      {state === null ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Looking…
          </Text>
        </Group>
      ) : snapshots.length === 0 ? (
        <Text size="sm" c="dimmed">
          No backups yet. Casebook takes the first one the next time you change something.
        </Text>
      ) : (
        <>
          <Table fz="sm">
            <Table.Tbody>
              {shown.map((snapshot) => (
                <Table.Tr key={snapshot.name}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm">{describeSnapshot(snapshot.takenAt)}</Text>
                      {snapshot.encrypted && (
                        <Tooltip label="Encrypted">
                          <IconLock size={13} style={{ opacity: 0.55, flex: "none" }} />
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Contents snapshot={snapshot} />
                  </Table.Td>
                  <Table.Td ta="right" w={1}>
                    {/* Nothing is offered for a file that didn't parse. A
                        Restore button that can only fail is the dead end the
                        recovery screen exists to have got rid of. */}
                    {snapshot.readable && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => setConfirming(snapshot)}
                        aria-label={`Restore the backup from ${describeSnapshot(snapshot.takenAt)}`}
                      >
                        Restore
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {snapshots.length > VISIBLE && (
            <Button
              variant="subtle"
              size="compact-sm"
              mt="xs"
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Show fewer" : `Show all ${snapshots.length} backups`}
            </Button>
          )}
        </>
      )}

      <Group gap="xs" mt="md">
        <Button
          variant="default"
          leftSection={<IconFolderOpen size={16} />}
          onClick={() => void api().revealBackupsFolder()}
        >
          Show in Finder
        </Button>
        <Button
          variant="default"
          leftSection={<IconListCheck size={16} />}
          onClick={() => void check()}
          loading={checking}
        >
          Check backups now
        </Button>
      </Group>

      <Text size="xs" c="dimmed" mt="md">
        Restoring never throws anything away: Casebook snapshots what's in front of you first, so
        picking the wrong one costs you nothing but a second go.
      </Text>

      <Modal
        opened={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Restore this backup?"
        centered
      >
        {confirming && (
          <Stack gap="sm">
            <Text size="sm">
              Casebook will replace what's in front of you with the backup from{" "}
              <strong>{describeSnapshot(confirming.takenAt)}</strong> — {headline(confirming)}.
            </Text>
            <Text size="sm" c="dimmed">
              What's here now is snapshotted first, so this is undoable. If it turns out to be the
              wrong one, restore the backup at the top of the list and you're back where you
              started.
            </Text>
            <Group justify="flex-end" gap="xs" mt="xs">
              <Button variant="default" onClick={() => setConfirming(null)} disabled={restoring}>
                Keep what's here
              </Button>
              <Button onClick={() => void restore(confirming)} loading={restoring}>
                Restore this backup
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Card>
  );
}

/**
 * What's in one snapshot, or why nobody can say.
 *
 * Encrypted-and-unopened is not damaged, and both arrive with `readable` false.
 * The main process says which it is rather than leaving it to be guessed from
 * `encrypted`: telling someone a perfectly good backup is corrupt — when in
 * fact the app simply hasn't been given the passphrase yet — is the worst wrong
 * answer this panel could give, and an inference gets to make it on its own the
 * first time those two facts come apart.
 */
function Contents({ snapshot }: { snapshot: SnapshotSummary }) {
  if (snapshot.readable) {
    return (
      <Text size="xs" c="dimmed">
        {headline(snapshot)}
      </Text>
    );
  }
  return (
    <Badge size="xs" variant="light" color="gray">
      {snapshot.locked ? "Locked" : "Couldn't be opened"}
    </Badge>
  );
}

/** "14 students, 212 entries" — the two numbers that tell one backup from another. */
function headline(snapshot: SnapshotSummary): string {
  const students = `${snapshot.students} ${snapshot.students === 1 ? "student" : "students"}`;
  const entries = `${snapshot.entries} ${snapshot.entries === 1 ? "entry" : "entries"}`;
  return `${students}, ${entries}`;
}
