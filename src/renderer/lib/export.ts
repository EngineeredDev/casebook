/**
 * Writing a file out of the app, and telling the user what happened.
 *
 * There is no such thing as a download here. The browser version made a blob
 * and clicked an invisible anchor at it; an Electron renderer has no download
 * behavior to trigger, so the main process opens a save dialog instead and
 * writes the file where it is told (see main/ipc.ts).
 *
 * Kept apart from csv.ts, which stays a pure formatter with nothing to say.
 */

import { notifications } from "@mantine/notifications";
import { api, bridgeMessage } from "./api.ts";
import { toCsv } from "./csv.ts";

export async function exportFile(filename: string, contents: string): Promise<void> {
  let result;
  try {
    result = await api().exportFile(filename, contents);
  } catch (error) {
    result = { error: bridgeMessage(error) };
  }

  // Dismissing the dialog is a decision, not a failure. Say nothing.
  if ("saved" in result && !result.saved) return;

  if ("error" in result) {
    notifications.show({
      color: "red",
      title: "Couldn't save the file",
      message: result.error,
      autoClose: false,
    });
    return;
  }

  notifications.show({
    color: "teal",
    title: "Exported",
    message: result.path,
  });
}

export function exportCsv(filename: string, rows: (string | number)[][]): Promise<void> {
  return exportFile(filename, toCsv(rows));
}
