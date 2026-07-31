import { useEffect, useState } from "react";
import { Alert, Button, Card, Code, Group, Loader, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconDownload } from "@tabler/icons-react";
import type { SelfUpdateAbility, UpdateInfo } from "../../shared/api.ts";
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
  const [selfUpdate, setSelfUpdate] = useState<SelfUpdateAbility | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  /** Null until a check has actually run, so "up to date" is never a guess. */
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    api()
      .getUpdateState()
      .then((state) => {
        setVersion(state.version);
        setAvailable(state.available);
        setSelfUpdate(state.selfUpdate);
      })
      .catch(() => setVersion("unknown"));

    // A scheduled check can finish while this page is open.
    return api().onUpdateAvailable((info) => {
      setAvailable(info);
      setCheckError(null);
    });
  }, []);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const result = await api().checkForUpdate();
      setCheckedAt(new Date());
      if ("error" in result) {
        setCheckError(result.error);
        return;
      }
      setAvailable(result.available ? result.info : null);
    } catch (err) {
      setCheckError(bridgeMessage(err));
    } finally {
      setChecking(false);
    }
  };

  /**
   * On success this never resolves anywhere useful — the app is already on its
   * way down to restart. Only a failure comes back, and a failure means the
   * running version is still the one on disk.
   */
  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await api().installUpdate();
      if ("error" in result) {
        setInstallError(result.error);
        setInstalling(false);
      }
    } catch (err) {
      setInstallError(bridgeMessage(err));
      setInstalling(false);
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

            {selfUpdate?.ok ? (
              <>
                <Text size="xs">
                  Casebook will download it, replace itself and reopen. Your data isn't touched, and
                  the version you're on now is kept until the new one has started.
                </Text>
                <Group gap="xs">
                  <Button
                    size="xs"
                    onClick={() => void install()}
                    loading={installing}
                    disabled={installing}
                  >
                    Update to {available.version} and reopen
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => void api().openReleasePage()}
                    disabled={installing}
                  >
                    What's new
                  </Button>
                </Group>
                {installing ? (
                  <Text size="xs" c="dimmed">
                    Downloading — this is about 115 MB, so give it a minute. Casebook will reopen on
                    its own.
                  </Text>
                ) : null}

                {/* An update that failed leaves the running version exactly as
                    it was, so this is a setback rather than a problem — but it
                    is also the moment to hand over the way that always works. */}
                {installError ? (
                  <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={18} />}>
                    <Stack gap="xs">
                      <Text size="xs">
                        {installError} You're still running {version}, and nothing has changed. Try
                        again, or install it yourself:
                      </Text>
                      <Code block>{INSTALL_COMMAND}</Code>
                    </Stack>
                  </Alert>
                ) : null}
              </>
            ) : (
              <>
                {/* Translocated, unwritable, or a dev build — each needs its own
                    advice, and the main process is the thing that knows which. */}
                <Text size="xs">
                  {selfUpdate?.reason} Quit Casebook and run this in Terminal instead — the same
                  command you installed it with. Your data is not touched.
                </Text>
                <Code block>{INSTALL_COMMAND}</Code>
                <Group gap="xs">
                  <Button size="xs" variant="default" onClick={() => void api().openReleasePage()}>
                    Open the release page
                  </Button>
                </Group>
              </>
            )}
          </Stack>
        </Alert>
      ) : null}

      {checkError ? (
        <Alert
          variant="light"
          color="yellow"
          icon={<IconAlertTriangle size={18} />}
          mt={available ? "sm" : 0}
        >
          <Text size="xs">
            Couldn't check for updates — {checkError} Casebook carries on working regardless; this
            is worth another try later rather than now.
          </Text>
        </Alert>
      ) : null}

      {!available && !checkError && checkedAt ? (
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
