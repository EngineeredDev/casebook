/**
 * Settings → AI features. The switch, the choice, and the way back out.
 *
 * Off until she says otherwise, and off means off: no model is fetched, no
 * process runs, and every AI affordance elsewhere in Casebook disappears. The
 * switch is the whole feature's front door, so the panel leads with what
 * agreeing costs — gigabytes onto a school laptop — rather than assuming she
 * has already decided and wants a progress bar.
 *
 * The model list is deliberately honest about two things it would be easy to
 * flatter. Only the first entry has been measured (scripts/llm-eval); the rest
 * are reasonable bets, and are described as such. And every entry states what
 * it needs against what this Mac has, because "it downloaded fine" and "it will
 * run here" are different questions and only the second one matters.
 *
 * The remove buttons matter as much as the download buttons. A feature that
 * takes 7 GB and offers no way to hand it back is one she cannot safely try.
 */

import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  Progress,
  Radio,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconDownload,
  IconPlayerPause,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import type { AiState, MemoryAdvice, ModelStatus } from "../../shared/llm.ts";
import { fitsMachine, gb, machineGb, MODELS, type ModelChoice } from "../../shared/models.ts";
import { api, bridgeMessage } from "../lib/api.ts";

export function AiPanel() {
  const [state, setState] = useState<AiState | null>(null);
  const [memory, setMemory] = useState<MemoryAdvice | null>(null);
  const [busy, setBusy] = useState(false);
  /** A model she has asked for that this Mac is too small for, awaiting a yes. */
  const [confirming, setConfirming] = useState<ModelChoice | null>(null);

  useEffect(() => {
    api()
      .getAiState()
      .then(setState)
      .catch(() => setState(null));
    // Progress arrives as a broadcast rather than by polling — a download runs
    // in the main process and outlives any one render.
    return api().onAiState(setState);
  }, []);

  // Only meaningful once something is downloaded, and it is about the model
  // she has chosen, so it is re-asked whenever that changes.
  useEffect(() => {
    if (!state?.enabled) return;
    api()
      .getMemoryAdvice()
      .then(setMemory)
      .catch(() => setMemory(null));
  }, [state?.enabled, state?.activeId]);

  const act = (work: () => Promise<AiState>, failure: string) => {
    setBusy(true);
    work()
      .then(setState)
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

  if (!state) return null;

  const statusOf = (id: string): ModelStatus =>
    state.models.find((m) => m.id === id)?.status ?? { state: "absent" };
  const downloadingSomething = state.models.some((m) => m.status.state === "downloading");
  const fits = (choice: ModelChoice) => fitsMachine(choice, state.machineBytes);

  const download = (choice: ModelChoice) => {
    // Choosing and fetching are one gesture here: pressing Download on a model
    // she has not selected plainly means "use this one". Sequenced rather than
    // fired together, so the download always starts against a settled choice.
    act(async () => {
      if (choice.id !== state.activeId) await api().selectModel(choice.id);
      return api().startModelDownload(choice.id);
    }, "The download didn't start");
  };

  return (
    <Card>
      <Group justify="space-between" mb={4} wrap="nowrap">
        <Group gap={8}>
          <IconSparkles size={18} />
          <Text fw={600}>AI features</Text>
          {state.enabled && <StateBadge status={state.active} />}
        </Group>
        <Switch
          checked={state.enabled}
          disabled={busy}
          onChange={(event) =>
            act(() => api().setAiEnabled(event.currentTarget.checked), "Couldn't change that")
          }
          label={state.enabled ? "On" : "Off"}
          labelPosition="left"
        />
      </Group>

      <Text size="sm" c="dimmed">
        Optional help with two things: guessing which category an imported entry belongs in, and
        summarising a student's notes. Everything runs on this Mac —{" "}
        <Text span fw={600}>
          nothing about a student is ever sent anywhere
        </Text>
        . It needs a model downloaded first, which is several gigabytes.
      </Text>

      {!state.enabled ? (
        <Text size="xs" c="dimmed" mt="xs">
          Off. Nothing has been downloaded and nothing runs.
          {state.diskBytes > 0 && (
            <>
              {" "}
              Except {gb(state.diskBytes)} of weights already on this Mac, which are kept — turning
              this back on uses them straight away, and each one can be removed below.
            </>
          )}
        </Text>
      ) : (
        <Stack gap="sm" mt="md">
          {memory && !memory.enough && state.active.state === "ready" && (
            <Alert color="ember" variant="light" title="Not much free memory right now">
              This model needs about {gb(memory.neededBytes)} while it runs, and there is around{" "}
              {gb(memory.availableBytes)} free. Closing a few apps — a browser especially — is
              usually enough. Nothing else about Casebook is affected.
            </Alert>
          )}

          <Radio.Group
            value={state.activeId}
            onChange={(id) => act(() => api().selectModel(id), "Couldn't switch")}
          >
            <Stack gap="xs">
              {MODELS.map((choice) => (
                <ModelRow
                  key={choice.id}
                  choice={choice}
                  status={statusOf(choice.id)}
                  active={choice.id === state.activeId}
                  fits={fits(choice)}
                  machineBytes={state.machineBytes}
                  busy={busy}
                  otherDownloadRunning={
                    downloadingSomething && statusOf(choice.id).state !== "downloading"
                  }
                  onDownload={() => (fits(choice) ? download(choice) : setConfirming(choice))}
                  onPause={() => act(() => api().pauseModelDownload(), "Couldn't pause")}
                  onRemove={() => act(() => api().removeModel(choice.id), "Couldn't remove it")}
                />
              ))}
            </Stack>
          </Radio.Group>

          <Text size="xs" c="dimmed">
            {state.diskBytes > 0
              ? `${gb(state.diskBytes)} on this Mac. `
              : "Nothing downloaded yet. "}
            Worth downloading at home rather than at school: these are large, and school networks
            often rate-limit them. A download that stops picks up where it left off, and only one
            runs at a time. The model loads only while a job is running and shuts itself down about
            a minute afterwards.
          </Text>
        </Stack>
      )}

      <TooBigModal
        choice={confirming}
        machineBytes={state.machineBytes}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const choice = confirming!;
          setConfirming(null);
          download(choice);
        }}
      />
    </Card>
  );
}

function ModelRow({
  choice,
  status,
  active,
  fits,
  machineBytes,
  busy,
  otherDownloadRunning,
  onDownload,
  onPause,
  onRemove,
}: {
  choice: ModelChoice;
  status: ModelStatus;
  active: boolean;
  fits: boolean;
  machineBytes: number;
  busy: boolean;
  otherDownloadRunning: boolean;
  onDownload: () => void;
  onPause: () => void;
  onRemove: () => void;
}) {
  return (
    <Radio.Card value={choice.id} p="sm" withBorder>
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <Radio.Indicator mt={2} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} mb={2} wrap="wrap">
            <Text fw={600} size="sm">
              {choice.label} {choice.size}
            </Text>
            <Text size="xs" c="dimmed">
              {choice.quant}
            </Text>
            {choice.measured && (
              <Badge size="xs" variant="light" color="teal">
                Measured here
              </Badge>
            )}
            {!fits && (
              <Badge size="xs" variant="light" color="ember">
                Wants a {machineGb(choice.wantsMachineBytes)} Mac
              </Badge>
            )}
            {active && (
              <Badge size="xs" variant="light" color="grape">
                In use
              </Badge>
            )}
          </Group>

          <Text size="xs" c="dimmed" mb={6}>
            {choice.blurb}
          </Text>

          <Group gap="lg" mb={status.state === "downloading" ? 6 : 0}>
            <Text size="xs" c="dimmed">
              {gb(choice.downloadBytes)} download
            </Text>
            <Text size="xs" c="dimmed">
              about {gb(choice.runBytes)} of memory while it runs
              {fits ? "" : ` — this Mac has ${machineGb(machineBytes)}`}
            </Text>
          </Group>

          {(status.state === "downloading" || status.state === "paused") && (
            <Box mt={4}>
              <Progress
                value={(status.receivedBytes / (status.totalBytes ?? choice.downloadBytes)) * 100}
                animated={status.state === "downloading"}
                mb={4}
              />
              <Text size="xs" c="dimmed">
                {gb(status.receivedBytes)} of {gb(status.totalBytes ?? choice.downloadBytes)}
                {status.state === "paused" ? " — paused" : ""}
              </Text>
            </Box>
          )}

          {status.state === "error" && (
            <Alert color="red" variant="light" p="xs" mt={4} icon={<IconAlertTriangle size={14} />}>
              <Text size="xs">{status.message}</Text>
            </Alert>
          )}
        </Box>

        {/*
          The whole card is the radio's label, so a click anywhere in it selects
          this model. Right for the card, wrong for these: removing a model she
          is not using must not quietly make it the one she is.
        */}
        <Stack gap={4} align="flex-end" onClick={(event) => event.stopPropagation()}>
          {status.state === "ready" && (
            <>
              <Badge size="sm" variant="light" color="teal">
                Downloaded
              </Badge>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconTrash size={13} />}
                disabled={busy}
                onClick={onRemove}
              >
                Remove
              </Button>
            </>
          )}

          {status.state === "downloading" && (
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<IconPlayerPause size={13} />}
              onClick={onPause}
            >
              Pause
            </Button>
          )}

          {(status.state === "absent" || status.state === "paused" || status.state === "error") && (
            <>
              <Button
                size="compact-xs"
                variant={active ? "filled" : "light"}
                leftSection={<IconDownload size={13} />}
                disabled={busy || otherDownloadRunning}
                onClick={onDownload}
              >
                {status.state === "paused"
                  ? "Resume"
                  : status.state === "error"
                    ? "Try again"
                    : "Download"}
              </Button>
              {status.state === "paused" && (
                <Anchor size="xs" c="dimmed" onClick={onRemove}>
                  Discard
                </Anchor>
              )}
            </>
          )}
        </Stack>
      </Group>
    </Radio.Card>
  );
}

/**
 * Asked before a download this Mac cannot comfortably run — not to forbid it.
 * The same build runs on an 8 GB Air and on a desktop, RAM detection is a
 * guess about the future as much as the present, and refusing outright would
 * make the larger models untestable on the machine that most wants to test
 * them. So: say plainly what will happen, and let her decide.
 */
function TooBigModal({
  choice,
  machineBytes,
  onCancel,
  onConfirm,
}: {
  choice: ModelChoice | null;
  machineBytes: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      opened={choice !== null}
      onClose={onCancel}
      title="Bigger than this Mac is comfortable with"
      centered
    >
      {choice && (
        <Stack gap="sm">
          <Text size="sm">
            {choice.label} {choice.size} needs about {gb(choice.runBytes)} of memory while it runs,
            and this Mac has {machineGb(machineBytes)} in total. It will download fine. When it
            runs, macOS will start swapping to disk — everything on the Mac gets slow, and a summary
            that takes twenty seconds on the right machine can take several minutes here.
          </Text>
          <Text size="sm" c="dimmed">
            Casebook checks free memory before every job and will refuse to start one rather than
            bring the Mac to a halt, so the likely outcome is {gb(choice.downloadBytes)} of disk
            spent on something that declines to run.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onCancel}>
              Pick something smaller
            </Button>
            <Button color="ember" onClick={onConfirm}>
              Download it anyway
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function StateBadge({ status }: { status: ModelStatus }) {
  const map = {
    off: { color: "gray", label: "Off" },
    absent: { color: "ember", label: "No model yet" },
    downloading: { color: "clinical", label: "Downloading" },
    paused: { color: "ember", label: "Paused" },
    ready: { color: "teal", label: "Ready" },
    error: { color: "red", label: "Problem" },
  } as const;
  const { color, label } = map[status.state];
  return (
    <Badge color={color} variant="light">
      {label}
    </Badge>
  );
}
