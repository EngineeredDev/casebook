import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Center, Code, Group, Loader, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconHistory, IconLock } from "@tabler/icons-react";
import type { RecoveryOffer } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { describeSnapshot } from "../lib/snapshots.ts";

/**
 * What she meets when the data file cannot be read.
 *
 * This screen matters more than anything else in the backup plan, and the
 * reason is that it is the only part of it a person ever has to operate. What
 * shipped before was an error and a Retry button that could not possibly
 * succeed — reading the same unreadable file again — which is a dead end
 * dressed as an action, at 7:45 in the morning, to someone who has just been
 * told her records won't open. Anyone would conclude the work was gone.
 *
 * So the offer is concrete: a named backup, when it was taken, and how much is
 * in it. Restoring never overwrites the unreadable file — it is moved aside
 * first, because however broken it is, it is still the newest copy in existence.
 */
export function RecoveryScreen({
  message,
  onRecovered,
}: {
  message: string;
  onRecovered: () => void;
}) {
  const [offer, setOffer] = useState<RecoveryOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    api()
      .getRecoveryOffer()
      .then(setOffer)
      // A failure to even look for a backup is not worth its own screen: the
      // screen already says the data would not load, which remains true.
      .catch(() => setOffer({ snapshot: null, locked: false }));
  }, []);

  const restore = useCallback(async () => {
    if (!offer?.snapshot) return;
    setBusy(true);
    setFailed(null);
    try {
      const result = await api().restoreSnapshot(offer.snapshot.name);
      if ("error" in result) {
        setFailed(result.error);
        return;
      }
      onRecovered();
    } catch (error) {
      setFailed(bridgeMessage(error));
    } finally {
      setBusy(false);
    }
  }, [offer, onRecovered]);

  if (!offer) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  return (
    <Center h="100vh" p="md">
      <Card maw={560} w="100%" withBorder>
        <Stack gap="md">
          <Group gap="xs" wrap="nowrap">
            {offer.locked ? (
              <IconLock size={20} />
            ) : (
              <IconAlertTriangle size={20} color="var(--mantine-color-red-6)" />
            )}
            <Text fw={600}>
              {offer.locked ? "This data is encrypted" : "Casebook couldn't read your data file"}
            </Text>
          </Group>

          <Text size="sm" c="dimmed">
            {message}
          </Text>

          {offer.snapshot && (
            <Alert color="blue" variant="light" icon={<IconHistory size={18} />}>
              <Stack gap="xs">
                <Text size="sm">
                  There's a backup from <strong>{describeSnapshot(offer.snapshot.takenAt)}</strong>,
                  with {offer.snapshot.students} students and {offer.snapshot.entries} entries in
                  it.
                </Text>
                <Text size="xs" c="dimmed">
                  Restoring keeps the file that wouldn't open — it's moved into your{" "}
                  <Code>backups</Code> folder rather than replaced, in case anything can be got out
                  of it later.
                </Text>
              </Stack>
            </Alert>
          )}

          {!offer.snapshot && !offer.locked && (
            <Text size="sm">
              There are no backups Casebook can read either. Nothing has been changed or deleted —
              open the data folder in Finder before doing anything else.
            </Text>
          )}

          {failed && (
            <Alert color="red" variant="light" title="That didn't work">
              {failed}
            </Alert>
          )}

          <Group gap="xs">
            {offer.snapshot && (
              <Button onClick={() => void restore()} loading={busy}>
                Restore this backup
              </Button>
            )}
            <Button variant="default" onClick={onRecovered} disabled={busy}>
              Try again
            </Button>
            <Button
              variant="subtle"
              onClick={() => void api().revealBackupsFolder()}
              disabled={busy}
            >
              Show backups in Finder
            </Button>
          </Group>
        </Stack>
      </Card>
    </Center>
  );
}
