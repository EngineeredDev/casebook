import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Divider,
  Group,
  List,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconLock, IconLockOpen, IconShieldCheck } from "@tabler/icons-react";
import type { EncryptionState } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";

/** Never, or something short enough to matter on a desk people walk past. */
const AUTO_LOCK_CHOICES = [
  { value: "never", label: "Never" },
  { value: "5", label: "After 5 minutes" },
  { value: "15", label: "After 15 minutes" },
  { value: "30", label: "After 30 minutes" },
  { value: "60", label: "After an hour" },
];

/**
 * The passphrase, and the plain truth about what it does and doesn't do.
 *
 * Off by default and deliberately so. This is the only feature in Casebook that
 * can make data unreadable, and the recovery sheet is the whole of the
 * mitigation — which is why turning it on ends in a dialog that cannot be
 * dismissed without saying the sheet has been dealt with.
 */
export function EncryptionPanel() {
  const [state, setState] = useState<EncryptionState | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [changing, setChanging] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api()
      .getEncryptionState()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  useEffect(refresh, [refresh]);

  const disable = useCallback(async () => {
    setDisabling(false);
    try {
      const result = await api().disableEncryption();
      if ("error" in result) {
        notifications.show({
          color: "red",
          title: "The passphrase is still on",
          message: result.error,
          autoClose: false,
        });
        return;
      }
      refresh();
      notifications.show({
        color: "teal",
        title: "Passphrase removed",
        message: "Your records are back to plain files in the data folder.",
      });
    } catch (error) {
      // A returned `{ error }` is the main process saying no; a rejection is it
      // failing to answer at all, and the two arrive by different routes. The
      // dialog has already closed by the time either lands, so an unhandled
      // rejection here reads as "Turn it off" doing nothing whatsoever — while
      // the passphrase is in fact still on, which is the half of it she cannot
      // see and would have no reason to check.
      notifications.show({
        color: "red",
        title: "The passphrase is still on",
        message: bridgeMessage(error),
        autoClose: false,
      });
    }
  }, [refresh]);

  const setAutoLock = useCallback((value: string | null) => {
    const minutes = value === null || value === "never" ? null : Number(value);
    void api()
      .setAutoLockMinutes(minutes)
      .then(setState)
      .catch((error: unknown) => {
        notifications.show({
          color: "red",
          title: "Couldn't change that",
          message: bridgeMessage(error),
        });
      });
  }, []);

  return (
    <Card>
      <Group justify="space-between" wrap="nowrap" mb={2}>
        <Text fw={600}>Passphrase</Text>
        {state?.enabled ? (
          <Badge color="teal" variant="light" leftSection={<IconShieldCheck size={12} />}>
            On
          </Badge>
        ) : (
          <Badge color="gray" variant="light">
            Off
          </Badge>
        )}
      </Group>

      <Text size="xs" c="dimmed" mb="sm">
        Encrypts your records on this computer, so that someone with the files — or with the Mac —
        can't read student names or notes without your passphrase. You type it once each time
        Casebook opens.
      </Text>

      {state?.enabled ? (
        <Stack gap="sm">
          <Select
            label="Lock automatically when the Mac is left idle"
            description="Locking clears the passphrase from memory. Nothing is lost — you just type it again."
            data={AUTO_LOCK_CHOICES}
            value={state.autoLockMinutes === null ? "never" : String(state.autoLockMinutes)}
            onChange={setAutoLock}
            allowDeselect={false}
            maw={280}
          />

          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconLock size={16} />}
              onClick={() => void api().lockNow()}
            >
              Lock now
            </Button>
            <Button variant="default" onClick={() => setChanging(true)}>
              Change passphrase…
            </Button>
            <Button
              variant="subtle"
              color="red"
              leftSection={<IconLockOpen size={16} />}
              onClick={() => setDisabling(true)}
            >
              Turn off…
            </Button>
          </Group>
        </Stack>
      ) : (
        <Button
          leftSection={<IconLock size={16} />}
          onClick={() => setEnabling(true)}
          disabled={state === null}
        >
          Turn on a passphrase…
        </Button>
      )}

      <Divider my="md" />

      {/*
        Stated here as well as in the plan, because a security feature that
        overstates itself is worse than none: it changes what someone is willing
        to do with the machine. Each of these is a real limit, not a caveat.
      */}
      <Text size="xs" fw={600} c="dimmed">
        What this does and doesn't protect
      </Text>
      <List size="xs" c="dimmed" mt={4} spacing={2}>
        <List.Item>
          If you forget the passphrase <strong>and</strong> lose the recovery key, the data is gone.
          There is no way around that — it's what encryption means.
        </List.Item>
        <List.Item>
          It protects the files: copied off the Mac, read from another account, sitting in your
          backup folder. It does not protect Casebook while it's open and unlocked in front of
          someone.
        </List.Item>
        <List.Item>
          On a school-managed Mac, whoever administers the machine still controls it and could
          capture the passphrase as you type it. This raises the bar; it can't beat the owner of the
          operating system.
        </List.Item>
        <List.Item>
          Exports and reports you save are plain files by design, and stay readable by anyone.
        </List.Item>
        <List.Item>
          Turn on FileVault in System Settings whichever way you go — it's the floor everything else
          stands on if the Mac is lost or stolen.
        </List.Item>
      </List>

      <EnableDialog
        opened={enabling}
        onClose={() => setEnabling(false)}
        onEnabled={(key) => {
          setEnabling(false);
          setRecoveryKey(key);
          refresh();
        }}
      />
      <RecoverySheet recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />
      <ChangeDialog opened={changing} onClose={() => setChanging(false)} />

      <Modal
        opened={disabling}
        onClose={() => setDisabling(false)}
        title="Turn off the passphrase?"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            Casebook will decrypt your records and your backups back into ordinary files. Anyone
            with this Mac, or with a copy of the data folder, will be able to read them again.
          </Text>
          <Text size="xs" c="dimmed">
            A copy of everything as it is now is saved to your backups folder first, so this is
            reversible.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDisabling(false)}>
              Keep it on
            </Button>
            <Button color="red" onClick={() => void disable()}>
              Turn it off
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

function EnableDialog({
  opened,
  onClose,
  onEnabled,
}: {
  opened: boolean;
  onClose: () => void;
  onEnabled: (recoveryKey: string) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const mismatched = again.length > 0 && passphrase !== again;
  const ready = passphrase.length >= 8 && passphrase === again;

  const submit = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api().enableEncryption(passphrase);
      if ("error" in result) {
        setFailure(result.error);
        /**
         * A recovery key on a failure means the worst case: the conversion
         * broke and could not be undone, so the passphrase is on, some files
         * are encrypted, and this is still the only moment the key will ever
         * exist. Show the sheet anyway — the operation failed, but the way
         * back into her data is real and is about to be lost forever.
         */
        if (result.recoveryKey) onEnabled(result.recoveryKey);
        return;
      }
      setPassphrase("");
      setAgain("");
      onEnabled(result.recoveryKey);
    } catch (error) {
      setFailure(bridgeMessage(error));
    } finally {
      setBusy(false);
    }
  }, [passphrase, onEnabled]);

  return (
    <Modal opened={opened} onClose={onClose} title="Turn on a passphrase" centered>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) void submit();
        }}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Choose something you'll remember — a short sentence works better than a short password.
            Casebook will encrypt everything in your data folder, including the backups.
          </Text>
          <PasswordInput
            label="Passphrase"
            description="At least 8 characters"
            value={passphrase}
            onChange={(event) => setPassphrase(event.currentTarget.value)}
            autoFocus
            data-autofocus
          />
          <PasswordInput
            label="Type it again"
            value={again}
            onChange={(event) => setAgain(event.currentTarget.value)}
            error={mismatched ? "These don't match." : undefined}
          />
          {failure && (
            <Alert color="red" variant="light">
              {failure}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!ready}>
              Turn it on
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * The one moment this key exists in a readable form.
 *
 * It is derived from nothing and stored nowhere, so once this dialog closes it
 * cannot be produced again — and it is the only way back in if the passphrase
 * is forgotten. Hence a dialog with no close button, no escape key and a
 * checkbox: not to be officious, but because everything about the surrounding
 * app is dismissible and this is the one thing that must not be dismissed by
 * reflex.
 */
function RecoverySheet({
  recoveryKey,
  onDone,
}: {
  recoveryKey: string | null;
  onDone: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  const save = useCallback(async () => {
    if (!recoveryKey) return;
    const sheet = [
      "Casebook recovery key",
      "",
      recoveryKey,
      "",
      "Keep this somewhere away from the Mac Casebook runs on.",
      "It is the only way into your records if you forget the passphrase.",
      "Anyone holding it can open your records, so treat it like a spare key.",
      "",
      `Written ${new Date().toLocaleString()}`,
    ].join("\n");
    await api().exportFile("casebook-recovery-key.txt", sheet);
  }, [recoveryKey]);

  return (
    <Modal
      opened={recoveryKey !== null}
      onClose={() => {
        /* Only the button below closes this. */
      }}
      title="Write this down now"
      centered
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      <Stack gap="md">
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
          This is the only time Casebook can show you this. It is not stored anywhere, and it cannot
          be produced again.
        </Alert>

        <Code block fz="lg" ta="center" style={{ letterSpacing: "0.08em" }}>
          {recoveryKey}
        </Code>

        <Text size="sm">
          If you forget your passphrase, this is the only way back into your records. Keep it
          somewhere that isn't this Mac — printed and filed, or in a password manager.
        </Text>
        <Text size="xs" c="dimmed">
          Anyone who has it can open your records, so keep it as carefully as you'd keep a spare key
          to the office. You can print this window with <Code>⌘P</Code>, or{" "}
          <Anchor component="button" type="button" size="xs" onClick={() => void save()}>
            save it as a file
          </Anchor>{" "}
          to move somewhere safe.
        </Text>

        <Checkbox
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
          label="I've written this down or printed it, and it isn't only on this Mac"
        />

        <Group justify="flex-end">
          <Button
            disabled={!acknowledged}
            onClick={() => {
              setAcknowledged(false);
              onDone();
            }}
          >
            Done
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ChangeDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api().changePassphrase(current, next);
      if ("error" in result) {
        setFailure(
          result.kind === "wrong-passphrase" ? "That isn't your current passphrase." : result.error,
        );
        return;
      }
      setCurrent("");
      setNext("");
      onClose();
      notifications.show({
        color: "teal",
        title: "Passphrase changed",
        message: "Your recovery key still works — it wasn't affected.",
      });
    } catch (error) {
      setFailure(bridgeMessage(error));
    } finally {
      setBusy(false);
    }
  }, [current, next, onClose]);

  return (
    <Modal opened={opened} onClose={onClose} title="Change passphrase" centered>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && current.length > 0 && next.length >= 8) void submit();
        }}
      >
        <Stack gap="md">
          <PasswordInput
            label="Current passphrase"
            value={current}
            onChange={(event) => setCurrent(event.currentTarget.value)}
            autoFocus
            data-autofocus
          />
          <PasswordInput
            label="New passphrase"
            description="At least 8 characters"
            value={next}
            onChange={(event) => setNext(event.currentTarget.value)}
          />
          {/*
            Worth saying out loud: the recovery key wraps the data key, not the
            passphrase, so changing one leaves the other working. Someone who
            assumed otherwise might throw away a sheet that is still their only
            way back in.
          */}
          <Text size="xs" c="dimmed">
            Your existing backups stay readable, and the recovery key you wrote down still works.
          </Text>
          {failure && (
            <Alert color="red" variant="light">
              {failure}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={current.length === 0 || next.length < 8}>
              Change it
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
