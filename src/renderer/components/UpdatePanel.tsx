import { useEffect, useState } from "react";
import { Alert, Button, Card, Code, Group, Loader, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconDownload } from "@tabler/icons-react";
import type { UpdateInfo } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/EngineeredDev/casebook/main/scripts/install-macos.sh | sh";

/**
 * Whether there is a newer Casebook, and what to do about it.
 *
 * Nothing here happens on its own. An update is offered and never applied
 * quietly — she should never come back to an app that has changed under her
 * without having been asked.
 */
export function UpdatePanel() {
  const [version, setVersion] = useState<string | null>(null);
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Null until a check has actually run, so "up to date" is never a guess. */
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    api()
      .getUpdateState()
      .then((state) => {
        setVersion(state.version);
        setAvailable(state.available);
      })
      .catch(() => setVersion("unknown"));

    // A scheduled check can finish while this page is open.
    return api().onUpdateAvailable((info) => {
      setAvailable(info);
      setError(null);
    });
  }, []);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await api().checkForUpdate();
      setCheckedAt(new Date());
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setAvailable(result.available ? result.info : null);
    } catch (err) {
      setError(bridgeMessage(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card>
      <Text fw={600}>Updates</Text>
      <Text size="xs" c="dimmed" mt={2} mb="sm">
        {version ? (
          <>
            You're running Casebook <Code>{version}</Code>. Casebook checks for a new version when
            it opens and every few hours, and will never install one without asking.
          </>
        ) : (
          <Group gap="xs">
            <Loader size="xs" />
            <span>Looking…</span>
          </Group>
        )}
      </Text>

      {available ? (
        <Alert variant="light" color="blue" icon={<IconDownload size={18} />}>
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Casebook {available.version} is available.
            </Text>
            <Text size="xs">
              To install it, quit Casebook and run this in Terminal — the same command you installed
              it with. Your data is not touched.
            </Text>
            <Code block>{INSTALL_COMMAND}</Code>
            <Group gap="xs">
              <Button size="xs" variant="default" onClick={() => void api().openReleasePage()}>
                Open the release page
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : null}

      {error ? (
        <Alert
          variant="light"
          color="yellow"
          icon={<IconAlertTriangle size={18} />}
          mt={available ? "sm" : 0}
        >
          <Text size="xs">
            Couldn't check for updates — {error} Casebook carries on working regardless; this is
            worth another try later rather than now.
          </Text>
        </Alert>
      ) : null}

      {!available && !error && checkedAt ? (
        <Alert variant="light" color="teal" icon={<IconCircleCheck size={18} />}>
          <Text size="xs">This is the newest version.</Text>
        </Alert>
      ) : null}

      <Group gap="xs" mt="sm">
        <Button
          variant="default"
          onClick={() => void check()}
          loading={checking}
          disabled={!version}
        >
          Check for updates
        </Button>
      </Group>
    </Card>
  );
}
