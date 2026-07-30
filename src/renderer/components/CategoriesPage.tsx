import { useState } from "react";
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconArchive, IconArchiveOff, IconClockOff } from "@tabler/icons-react";
import { useStore } from "../store.tsx";
import type { CategoryGroup } from "../../shared/types.ts";

const GROUPS = [
  { value: "direct", label: "Direct" },
  { value: "indirect", label: "Indirect" },
];

export function CategoriesPage() {
  const { doc, addCategory, updateCategory } = useStore();
  const [newCatName, setNewCatName] = useState("");
  const [newCatGroup, setNewCatGroup] = useState<CategoryGroup>("indirect");

  const create = () => {
    if (!newCatName.trim()) return;
    addCategory(newCatName, newCatGroup);
    setNewCatName("");
  };

  return (
    <Card maw={620}>
      <Text fw={600}>Categories</Text>
      <Text size="xs" c="dimmed" mt={2} mb="sm">
        Rename, regroup, or archive. Archived categories keep their history. Mark a category{" "}
        <strong>untimed</strong> to log it as an event with no minutes — for no-shows and
        cancellations. Entries already logged keep the time they have.
      </Text>
      <Stack gap={6}>
        {doc.categories.map((c) => (
          <Group key={c.id} gap="xs" wrap="nowrap">
            <span className={`cat-dot ${c.group}`} />
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              value={c.name}
              onChange={(e) => updateCategory(c.id, { name: e.currentTarget.value })}
            />
            <Select
              size="xs"
              w={100}
              allowDeselect={false}
              data={GROUPS}
              value={c.group}
              onChange={(v) => updateCategory(c.id, { group: v as CategoryGroup })}
            />
            <Tooltip label={c.untimed ? "Untimed — give it a duration" : "Make untimed"}>
              <ActionIcon
                variant={c.untimed ? "light" : "subtle"}
                color={c.untimed ? "ember" : "gray"}
                aria-label={c.untimed ? "Make category timed" : "Make category untimed"}
                aria-pressed={!!c.untimed}
                onClick={() => updateCategory(c.id, { untimed: !c.untimed })}
              >
                <IconClockOff size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={c.archived ? "Restore" : "Archive"}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={c.archived ? "Restore category" : "Archive category"}
                onClick={() => updateCategory(c.id, { archived: !c.archived })}
              >
                {c.archived ? <IconArchiveOff size={16} /> : <IconArchive size={16} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
      </Stack>

      <Group gap="xs" mt="md" align="flex-end">
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          placeholder="New category name"
          value={newCatName}
          onChange={(e) => setNewCatName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <Select
          size="xs"
          w={100}
          allowDeselect={false}
          data={GROUPS}
          value={newCatGroup}
          onChange={(v) => setNewCatGroup(v as CategoryGroup)}
        />
        <Button size="xs" variant="default" disabled={!newCatName.trim()} onClick={create}>
          Add
        </Button>
      </Group>
    </Card>
  );
}
