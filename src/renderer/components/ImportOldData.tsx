import { useEffect, useState } from "react";
import { Alert, Button, Code, Group, List, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCircleCheck, IconPackageImport } from "@tabler/icons-react";
import type { LegacyInstall } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";
import { useStore } from "../store.tsx";

type Stage = "offer" | "imported";

/**
 * The one moment the Electron app has to get right for someone upgrading: it
 * opens, ~/Casebook is empty, and every student she has ever logged is sitting
 * beside an executable in ~/Applications that this version knows nothing about.
 * Without this she opens Casebook and finds her work gone.
 *
 * So it looks, and if it finds something it says so before she has to wonder.
 * Nothing is offered once there are entries here — importing over real data
 * would be a data-loss bug wearing a helpful face, and the main process refuses
 * it independently of this component.
 */
export function ImportOldData() {
  const { doc, reload } = useStore();
  const [found, setFound] = useState<LegacyInstall | null>(null);
  const [stage, setStage] = useState<Stage>("offer");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const empty = doc.students.length === 0 && doc.entries.length === 0;

  useEffect(() => {
    if (!empty) return;
    // A failure here means no offer, which is the same as finding nothing —
    // and interrupting an empty app with an error about an app she may never
    // have had would be worse than silence.
    api()
      .findLegacyInstall()
      .then(setFound)
      .catch(() => {});
  }, [empty]);

  // Dismissing it is not a decision that has to stick: it is offered again next
  // time the app opens, for as long as there is still nothing in here.
  if (!found || dismissed) return null;

  const runImport = async () => {
    setBusy(true);
    try {
      const result = await api().importLegacyData(found.dir);
      if ("error" in result) {
        notifications.show({
          color: "red",
          title: "Nothing was imported",
          message: result.error,
          autoClose: false,
        });
        return;
      }
      reload();
      setStage("imported");
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Nothing was imported",
        message: bridgeMessage(error),
        autoClose: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const findElsewhere = async () => {
    setBusy(true);
    try {
      const picked = await api().chooseLegacyInstall();
      if (picked) setFound(picked);
    } finally {
      setBusy(false);
    }
  };

  const retire = async () => {
    setBusy(true);
    try {
      const result = await api().retireLegacyInstall(found.dir);
      if ("error" in result) {
        notifications.show({
          color: "red",
          title: "The old Casebook is still there",
          message: result.error,
          autoClose: false,
        });
        return;
      }
      notifications.show({
        color: "teal",
        title: "Old Casebook removed",
        message: "It won't start at login any more.",
      });
    } finally {
      setBusy(false);
      setDismissed(true);
    }
  };

  return (
    <Modal
      opened
      onClose={() => setDismissed(true)}
      title={stage === "offer" ? "Bring your data over" : "Your data is here"}
      centered
      size="lg"
      closeOnClickOutside={false}
    >
      {stage === "offer" ? (
        <Stack gap="sm">
          <Text size="sm">
            This looks like your first time opening the new Casebook, and there's an older one on
            this Mac with work in it.
          </Text>
          <Alert variant="light" icon={<IconPackageImport size={18} />}>
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                {found.entries} {found.entries === 1 ? "entry" : "entries"} · {found.students}{" "}
                {found.students === 1 ? "student" : "students"}
              </Text>
              <Text size="xs" c="dimmed">
                Last changed {new Date(found.modified).toLocaleDateString()} ·{" "}
                {found.backups === 0
                  ? "no backups"
                  : `${found.backups} ${found.backups === 1 ? "backup" : "backups"}`}
              </Text>
              <Code>{found.dir}</Code>
            </Stack>
          </Alert>
          <Text size="xs" c="dimmed">
            Nothing is moved or deleted: the old folder stays exactly as it is, and Casebook copies
            what's in it.
          </Text>
          <Group justify="space-between" mt="xs">
            <Button
              variant="subtle"
              color="gray"
              onClick={() => void findElsewhere()}
              disabled={busy}
            >
              That's not it…
            </Button>
            <Group gap="xs">
              <Button variant="default" onClick={() => setDismissed(true)} disabled={busy}>
                Not now
              </Button>
              <Button onClick={() => void runImport()} loading={busy}>
                Bring it over
              </Button>
            </Group>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Alert variant="light" color="teal" icon={<IconCircleCheck size={18} />}>
            {/* The counts come from what was found rather than from the store,
                which is still catching up with the reload for a frame or two —
                long enough to say "0 entries" to someone who just moved their
                entire caseload. */}
            <Text size="sm">
              {found.entries} entries and {found.students} students are now in Casebook. The
              originals are untouched in <Code>{found.dir}</Code>.
            </Text>
          </Alert>

          {found.launchAgent || found.executable ? (
            <>
              <Text size="sm">
                The old Casebook still starts itself every time you log in. Tidying it up will:
              </Text>
              <List size="sm" spacing={2}>
                <List.Item>stop it launching at login</List.Item>
                <List.Item>
                  delete the old app <Code>{found.dir}/Casebook</Code>
                </List.Item>
              </List>
              <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={18} />}>
                <Text size="xs">
                  Its <Code>data.json</Code> and backups stay where they are, as a second copy you
                  can delete yourself once you're confident everything came across.
                </Text>
              </Alert>
              <Group justify="flex-end" gap="xs" mt="xs">
                <Button variant="default" onClick={() => setDismissed(true)} disabled={busy}>
                  Leave it for now
                </Button>
                <Button color="red" onClick={() => void retire()} loading={busy}>
                  Remove the old Casebook
                </Button>
              </Group>
            </>
          ) : (
            <Group justify="flex-end" mt="xs">
              <Button onClick={() => setDismissed(true)}>Done</Button>
            </Group>
          )}
        </Stack>
      )}
    </Modal>
  );
}
