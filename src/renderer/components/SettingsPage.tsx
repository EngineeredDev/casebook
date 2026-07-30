import { useCallback, useEffect, useState } from "react";
import { Anchor, Button, Card, Code, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFolderOpen, IconFolderSymlink } from "@tabler/icons-react";
import type { DataLocation } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";

/**
 * Where the data folder is, and how to put it somewhere else.
 *
 * The location is never asked at first run — the app picks ~/Casebook and gets
 * on with it. This page exists for the person who later wants it on an external
 * drive, or in a synced folder, and who otherwise has no way to say so.
 */
export function SettingsPage() {
  const [location, setLocation] = useState<DataLocation | null>(null);
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

  const reveal = () => {
    void api().revealDataFolder();
  };

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
          This folder holds <Code>data.json</Code> and a <Code>backups</Code> folder of daily
          snapshots. Copying it copies everything Casebook knows.
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
            onClick={reveal}
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

      <Card>
        <Text fw={600}>Backups</Text>
        <Text size="xs" c="dimmed" mt={2}>
          Casebook snapshots <Code>data.json</Code> into <Code>backups</Code> before the first
          change of each day, and keeps the most recent 30. To keep a copy off this computer, take
          the whole folder — or use{" "}
          <Anchor component={Link} to="/reports" size="xs">
            Reports → Export → Full data file
          </Anchor>
          , which is the same data in one file.
        </Text>
      </Card>
    </Stack>
  );
}
