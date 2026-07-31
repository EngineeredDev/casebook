import { useCallback, useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  Card,
  Center,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import type { EncryptionFailure } from "../../shared/api.ts";
import { api, bridgeMessage } from "../lib/api.ts";

/**
 * The first thing seen at every launch once the passphrase is on.
 *
 * It stands in front of the document rather than beside it: nothing is loaded,
 * and nothing can be, until the key exists in the main process. The passphrase
 * lives only in this field and only until it is sent — there is no Keychain
 * behind this and no "remember on this Mac", because the app is ad-hoc signed
 * and a Keychain-held key would be re-prompted after every self-update, or
 * silently regenerated and take every encrypted file with it.
 *
 * The recovery path is deliberately one click away rather than hidden. Somebody
 * reaching this screen having forgotten the passphrase is having the worst
 * moment this feature can produce, and the sheet they were made to write down
 * is the entire mitigation for it.
 */
export function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");

  const wording = (message: string, kind: EncryptionFailure): string => {
    if (kind === "wrong-passphrase") return "That passphrase didn't open it. Try again.";
    if (kind === "malformed-recovery-key") {
      return "That doesn't look like a recovery key — it's 26 letters and digits, in groups of five.";
    }
    if (kind === "wrong-recovery-key") return "That recovery key isn't for this data.";
    return message;
  };

  const submit = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = recovering
        ? await api().unlockWithRecoveryKey(recoveryKey, newPassphrase)
        : await api().unlock(passphrase);
      if ("error" in result) {
        setFailure(wording(result.error, result.kind));
        return;
      }
      // Cleared before anything else happens, so the passphrase does not sit in
      // a React state object for the rest of the session.
      setPassphrase("");
      setRecoveryKey("");
      setNewPassphrase("");
      onUnlocked();
    } catch (error) {
      setFailure(bridgeMessage(error));
    } finally {
      setBusy(false);
    }
  }, [recovering, recoveryKey, newPassphrase, passphrase, onUnlocked]);

  const ready = recovering
    ? recoveryKey.trim().length > 0 && newPassphrase.length > 0
    : passphrase.length > 0;

  return (
    <Center h="100vh" p="md">
      <Card maw={440} w="100%" withBorder>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) void submit();
          }}
        >
          <Stack gap="md">
            <Group gap="xs" wrap="nowrap">
              <IconLock size={20} />
              <Text fw={600}>{recovering ? "Use your recovery key" : "Casebook is locked"}</Text>
            </Group>

            {recovering ? (
              <>
                <Text size="sm" c="dimmed">
                  Type the recovery key from the sheet you printed when you turned the passphrase
                  on, then choose a new passphrase.
                </Text>
                <TextInput
                  label="Recovery key"
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"
                  value={recoveryKey}
                  onChange={(event) => setRecoveryKey(event.currentTarget.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
                <PasswordInput
                  label="New passphrase"
                  value={newPassphrase}
                  onChange={(event) => setNewPassphrase(event.currentTarget.value)}
                />
              </>
            ) : (
              <>
                <Text size="sm" c="dimmed">
                  Your records are encrypted. Casebook needs your passphrase to open them.
                </Text>
                <PasswordInput
                  label="Passphrase"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.currentTarget.value)}
                  autoFocus
                  data-autofocus
                />
              </>
            )}

            {failure && (
              <Alert color="red" variant="light">
                {failure}
              </Alert>
            )}

            <Group justify="space-between" wrap="nowrap">
              <Anchor
                component="button"
                type="button"
                size="xs"
                onClick={() => {
                  setRecovering((was) => !was);
                  setFailure(null);
                }}
              >
                {recovering ? "Use my passphrase instead" : "I've forgotten my passphrase"}
              </Anchor>
              <Button type="submit" loading={busy} disabled={!ready}>
                Unlock
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
