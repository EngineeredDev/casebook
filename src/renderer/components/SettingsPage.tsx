import { useCallback, useEffect, useState } from "react";
import { Button, Card, Code, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFolderOpen, IconFolderSymlink } from "@tabler/icons-react";
import type { BackupsState, DataLocation, MirrorState } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { useStore } from "../store.tsx";
import { AiPanel } from "./AiPanel.tsx";
import { BackupsPanel } from "./BackupsPanel.tsx";
import { EncryptionPanel } from "./EncryptionPanel.tsx";
import { MirrorPanel } from "./MirrorPanel.tsx";
import { UpdatePanel } from "./UpdatePanel.tsx";

/**
 * Where the data folder is, and how to put it somewhere else.
 *
 * The location is never asked at first run — the app picks ~/Casebook and gets
 * on with it. This page exists for the person who later wants it on an external
 * drive, or in a synced folder, and who otherwise has no way to say so.
 */
export function SettingsPage() {
  const { reload } = useStore();
  const [location, setLocation] = useState<DataLocation | null>(null);
  const [backups, setBackups] = useState<BackupsState | null>(null);
  const [moving, setMoving] = useState(false);

  const refresh = useCallback(() => {
    api()
      .getDataLocation()
      .then(setLocation)
      .catch((error: unknown) => {
        notifications.show({
          color: "red",
          title: "Couldn't read your settings",
          message: bridgeMessage(error),
        });
      });
  }, []);

  useEffect(refresh, [refresh]);

  /**
   * One read for both panels below. They are looking at the same folder, and
   * fetching it twice would have them disagreeing about it from the moment
   * either one changed something.
   */
  const refreshBackups = useCallback(() => {
    api()
      .getBackups()
      .then(setBackups)
      .catch((error: unknown) => {
        notifications.show({
          color: "red",
          title: "Couldn't read your backups",
          message: bridgeMessage(error),
        });
      });
  }, []);

  useEffect(refreshBackups, [refreshBackups]);

  /**
   * The mirror calls each hand back the state they produced, which beats a
   * re-read: `setMirrorFolder` starts a copy in the background that a fresh
   * `getBackups()` would race and report the wrong side of.
   */
  const applyMirror = useCallback((mirror: MirrorState) => {
    setBackups((current) => (current ? { ...current, mirror } : current));
  }, []);

  /**
   * A restore replaced the file this window is holding a copy of. `reload` is
   * not optional: without it the store keeps the pre-restore document, and the
   * next edit saves that straight back over what was just restored — turning a
   * recovery into the second loss of the day. The list is re-read too, because
   * the restore snapshotted the outgoing state on its way past and that
   * snapshot is now the newest row in it.
   */
  const restored = useCallback(() => {
    reload();
    refreshBackups();
  }, [reload, refreshBackups]);

  const relocate = async () => {
    const target = await api().chooseDataFolder();
    if (!target) return;

    setMoving(true);
    try {
      const result = await api().relocateData(target);
      if ("error" in result) {
        notifications.show({
          color: "red",
          title: "Nothing was moved",
          message: result.error,
          autoClose: false,
        });
        return;
      }
      refresh();
      // The backups folder moved with the data folder, so the list the panel
      // below is showing is describing a place Casebook has stopped using.
      refreshBackups();
      notifications.show({
        color: "teal",
        title: "Casebook is using the new folder",
        message: `Your old copy is still where it was — delete it once you're happy.`,
        autoClose: false,
      });
    } finally {
      setMoving(false);
    }
  };

  return (
    <Stack gap="md" maw={620}>
      <Card>
        <Text fw={600}>Where your data is kept</Text>
        <Text size="xs" c="dimmed" mt={2} mb="sm">
          This folder holds <Code>data.json</Code> and a <Code>backups</Code> folder of snapshots.
          Copying it copies everything Casebook knows.
        </Text>

        {location ? (
          <Code block>{location.dir}</Code>
        ) : (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Looking…
            </Text>
          </Group>
        )}

        <Group gap="xs" mt="sm">
          <Button
            variant="default"
            leftSection={<IconFolderOpen size={16} />}
            onClick={() => void api().revealDataFolder()}
            disabled={!location}
          >
            Show in Finder
          </Button>
          <Button
            variant="default"
            leftSection={<IconFolderSymlink size={16} />}
            onClick={() => void relocate()}
            loading={moving}
            disabled={!location?.relocatable}
          >
            Move to another folder…
          </Button>
        </Group>

        {location && !location.relocatable && (
          <Text size="xs" c="dimmed" mt="xs">
            A development build always keeps its data in the repository, so there's nothing to move.
          </Text>
        )}

        <Text size="xs" c="dimmed" mt="md">
          Moving copies your data across and checks it arrived before switching over. The old copy
          is left exactly where it is — nothing is deleted for you.
        </Text>
      </Card>

      <BackupsPanel state={backups} onRefresh={refreshBackups} onRestored={restored} />
      <MirrorPanel mirror={backups?.mirror ?? null} onChange={applyMirror} />
      <EncryptionPanel />
      <AiPanel />
      <UpdatePanel />
    </Stack>
  );
}
