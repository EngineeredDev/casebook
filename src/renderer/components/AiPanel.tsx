/**
 * Settings → AI features. The opt-in, and the way back out.
 *
 * Off until she says otherwise, and the panel leads with what agreeing costs:
 * a 2.5 GB download onto a school laptop. Everything about the wording assumes
 * she is deciding whether this is worth the disk, not that she has already
 * decided and wants a progress bar.
 *
 * The remove button matters as much as the download button. A feature that
 * takes 2.5 GB and offers no way to hand it back is one she cannot safely try.
 */

import { useEffect, useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, Progress, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconPlayerPause, IconSparkles, IconTrash } from "@tabler/icons-react";
import type { MemoryAdvice, ModelStatus } from "../../shared/llm.ts";
import { api, bridgeMessage } from "../lib/api.ts";

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function AiPanel() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [memory, setMemory] = useState<MemoryAdvice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api()
      .getModelStatus()
      .then(setStatus)
      .catch(() => setStatus({ state: "absent" }));
    api()
      .getMemoryAdvice()
      .then(setMemory)
      .catch(() => setMemory(null));
    // Progress arrives as a broadcast rather than by polling — the download
    // runs in the main process and outlives any one render.
    return api().onModelStatus(setStatus);
  }, []);

  const act = (work: () => Promise<ModelStatus>, failure: string) => {
    setBusy(true);
    work()
      .then(setStatus)
      .catch((error: unknown) => {
        notifications.show({
          color: "red",
          title: failure,
          message: bridgeMessage(error),
          autoClose: false,
        });
      })
      .finally(() => setBusy(false));
  };

  if (!status) return null;

  return (
    <Card>
      <Group justify="space-between" mb={4}>
        <Group gap={8}>
          <IconSparkles size={18} />
          <Text fw={600}>AI features</Text>
        </Group>
        <StateBadge status={status} />
      </Group>

      <Text size="sm" c="dimmed" mb="sm">
        Optional help with two things: guessing which category an imported entry belongs in, and
        summarising a student's notes. Everything runs on this Mac —{" "}
        <Text span fw={600}>
          nothing about a student is ever sent anywhere
        </Text>
        . It needs a {gb(2_500_000_000)} download first.
      </Text>

      {status.state === "absent" && (
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            Worth doing at home rather than at school: it is a large download, and school networks
            often rate-limit it. If it stops partway it picks up where it left off.
          </Text>
          <Group>
            <Button
              leftSection={<IconDownload size={16} />}
              loading={busy}
              onClick={() => act(() => api().startModelDownload(), "The download didn't start")}
            >
              Download and turn on
            </Button>
          </Group>
        </Stack>
      )}

      {(status.state === "downloading" || status.state === "paused") && (
        <Stack gap="xs">
          <Progress
            value={
              status.totalBytes
                ? (status.receivedBytes / status.totalBytes) * 100
                : (status.receivedBytes / 2_500_000_000) * 100
            }
            animated={status.state === "downloading"}
          />
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {gb(status.receivedBytes)} of {gb(status.totalBytes ?? 2_500_000_000)}
              {status.state === "paused" ? " — paused" : ""}
            </Text>
            <Group gap="xs">
              {status.state === "downloading" ? (
                <Button
                  size="compact-sm"
                  variant="default"
                  leftSection={<IconPlayerPause size={14} />}
                  onClick={() => act(() => api().pauseModelDownload(), "Couldn't pause")}
                >
                  Pause
                </Button>
              ) : (
                <Button
                  size="compact-sm"
                  onClick={() => act(() => api().startModelDownload(), "Couldn't resume")}
                >
                  Resume
                </Button>
              )}
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                onClick={() => act(() => api().removeModel(), "Couldn't discard it")}
              >
                Discard
              </Button>
            </Group>
          </Group>
        </Stack>
      )}

      {status.state === "ready" && (
        <Stack gap="xs">
          {memory && !memory.enough && (
            <Alert color="ember" variant="light" title="Not much free memory right now">
              The AI features need about {gb(memory.neededBytes)} while they run, and there is
              around {gb(memory.availableBytes)} free. Closing a few apps — a browser especially —
              is usually enough. Nothing else about Casebook is affected.
            </Alert>
          )}
          <Text size="xs" c="dimmed">
            Ready. It loads only while a job is running and shuts itself down about a minute
            afterwards, so it is not using memory the rest of the time.
          </Text>
          <Group>
            <Button
              variant="default"
              color="red"
              leftSection={<IconTrash size={16} />}
              loading={busy}
              onClick={() => act(() => api().removeModel(), "Couldn't remove it")}
            >
              Remove downloaded model ({gb(status.bytes)})
            </Button>
          </Group>
        </Stack>
      )}

      {status.state === "error" && (
        <Stack gap="xs">
          <Alert color="red" variant="light" title="The download didn't finish">
            {status.message}
          </Alert>
          <Group>
            <Button
              leftSection={<IconDownload size={16} />}
              loading={busy}
              onClick={() => act(() => api().startModelDownload(), "Couldn't start again")}
            >
              Try again
            </Button>
            <Anchor
              size="sm"
              c="dimmed"
              onClick={() => act(() => api().removeModel(), "Couldn't clear it")}
            >
              Clear what was downloaded
            </Anchor>
          </Group>
        </Stack>
      )}
    </Card>
  );
}

function StateBadge({ status }: { status: ModelStatus }) {
  const map = {
    absent: { color: "gray", label: "Off" },
    downloading: { color: "clinical", label: "Downloading" },
    paused: { color: "ember", label: "Paused" },
    ready: { color: "teal", label: "On" },
    error: { color: "red", label: "Problem" },
  } as const;
  const { color, label } = map[status.state];
  return (
    <Badge color={color} variant="light">
      {label}
    </Badge>
  );
}
