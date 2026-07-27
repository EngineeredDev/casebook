import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  Loader,
  MantineProvider,
  NavLink,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Notifications, notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconChartBar,
  IconCircleCheck,
  IconFileDescription,
  IconMoon,
  IconPencilPlus,
  IconSun,
  IconUsers,
} from "@tabler/icons-react";
import { theme } from "./theme.tsx";
import { StoreProvider, useStore } from "./store.tsx";
import { LogPage } from "./components/LogPage.tsx";
import { DashboardPage } from "./components/DashboardPage.tsx";
import { StudentsPage } from "./components/StudentsPage.tsx";
import { ReportsPage } from "./components/ReportsPage.tsx";

type Page = "log" | "dashboard" | "students" | "reports";

const NAV: { key: Page; label: string; icon: typeof IconPencilPlus; hint: string }[] = [
  { key: "log", label: "Log", icon: IconPencilPlus, hint: "Record time" },
  { key: "dashboard", label: "Dashboard", icon: IconChartBar, hint: "Charts and totals" },
  { key: "students", label: "Students", icon: IconUsers, hint: "Roster and categories" },
  { key: "reports", label: "Reports", icon: IconFileDescription, hint: "Print and export" },
];

function SaveStatus() {
  const { saveState } = useStore();
  if (saveState === "saving") {
    return (
      <Group gap={6} c="dimmed">
        <Loader size={12} />
        <Text size="xs">Saving…</Text>
      </Group>
    );
  }
  if (saveState === "saved") {
    return (
      <Group gap={4} c="dimmed">
        <IconCircleCheck size={14} />
        <Text size="xs">Saved</Text>
      </Group>
    );
  }
  return (
    <Badge color="red" variant="light" size="sm" leftSection={<IconAlertTriangle size={12} />}>
      {saveState === "conflict" ? "Conflict" : "Save failed"}
    </Badge>
  );
}

function ThemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  const next = scheme === "light" ? "dark" : "light";
  return (
    <Tooltip label={`Switch to ${next} mode`}>
      <ActionIcon
        variant="default"
        size="md"
        aria-label={`Switch to ${next} mode`}
        onClick={() => setColorScheme(next)}
      >
        {scheme === "light" ? <IconMoon size={16} /> : <IconSun size={16} />}
      </ActionIcon>
    </Tooltip>
  );
}

/** A concurrent-window save conflict needs an explicit choice, so it gets a persistent alert. */
function ConflictAlert() {
  const { saveState, reload } = useStore();
  useEffect(() => {
    if (saveState !== "conflict") return;
    notifications.show({
      id: "conflict",
      color: "red",
      title: "Another window saved first",
      message: "Reload to pick up the latest data.",
      autoClose: false,
    });
    return () => {
      notifications.hide("conflict");
    };
  }, [saveState]);

  if (saveState !== "conflict") return null;
  return (
    <Alert
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={18} />}
      title="Another window saved changes first"
      mb="md"
      className="no-print"
    >
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          Reload to pick up the latest data. Unsynced edits in this window will be lost.
        </Text>
        <Button size="xs" color="red" onClick={reload} style={{ flex: "none" }}>
          Reload data
        </Button>
      </Group>
    </Alert>
  );
}

function Shell() {
  const [page, setPage] = useState<Page>("log");
  const [mobileOpened, mobile] = useDisclosure(false);
  const [desktopOpened, desktop] = useDisclosure(true);
  /** Bumped by "Log time" so the Log page knows to refocus the student field. */
  const [quickAdd, setQuickAdd] = useState(0);

  const go = (next: Page) => {
    setPage(next);
    mobile.close();
  };

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{
        width: 210,
        breakpoint: "sm",
        collapsed: { mobile: !mobileOpened, desktop: !desktopOpened },
      }}
      padding="md"
    >
      <AppShell.Header className="no-print">
        <Group h="100%" px="md" gap="sm" wrap="nowrap">
          <Burger opened={mobileOpened} onClick={mobile.toggle} hiddenFrom="sm" size="sm" />
          <Burger opened={desktopOpened} onClick={desktop.toggle} visibleFrom="sm" size="sm" />
          <Box w={10} h={10} bg="var(--direct)" style={{ borderRadius: "50%", flex: "none" }} />
          <Text fw={600} size="sm">
            Clinician Tracker
          </Text>
          <Group ml="auto" gap="sm" wrap="nowrap">
            <SaveStatus />
            <ThemeToggle />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm" className="no-print">
        <AppShell.Section grow>
          {NAV.map((item) => (
            <NavLink
              key={item.key}
              active={page === item.key}
              label={item.label}
              description={item.hint}
              leftSection={<item.icon size={18} stroke={1.6} />}
              onClick={() => go(item.key)}
              variant="light"
              mb={2}
            />
          ))}
        </AppShell.Section>
        <AppShell.Section>
          <Button
            fullWidth
            leftSection={<IconPencilPlus size={16} />}
            onClick={() => {
              go("log");
              setQuickAdd((n) => n + 1);
            }}
          >
            Log time
          </Button>
          <Text size="xs" c="dimmed" ta="center" mt="xs">
            Saved locally on this computer
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <ConflictAlert />
        {page === "log" && <LogPage focusSignal={quickAdd} />}
        {page === "dashboard" && <DashboardPage />}
        {page === "students" && <StudentsPage />}
        {page === "reports" && <ReportsPage />}
      </AppShell.Main>
    </AppShell>
  );
}

export function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="top-right" />
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </MantineProvider>
  );
}
