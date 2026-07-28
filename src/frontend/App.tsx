import { useEffect, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Card,
  Group,
  Loader,
  MantineProvider,
  NavLink,
  Stack,
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
import { Link, navigate, useIsActive, useLocation, useRoute } from "./lib/router.tsx";
import { LogPage } from "./components/LogPage.tsx";
import { DashboardPage } from "./components/DashboardPage.tsx";
import { StudentsPage } from "./components/StudentsPage.tsx";
import { StudentPage } from "./components/StudentPage.tsx";
import { ReportsPage } from "./components/ReportsPage.tsx";

const NAV: { path: string; label: string; icon: typeof IconPencilPlus; hint: string }[] = [
  { path: "/log", label: "Log", icon: IconPencilPlus, hint: "Record time" },
  { path: "/dashboard", label: "Dashboard", icon: IconChartBar, hint: "Charts and totals" },
  { path: "/students", label: "Students", icon: IconUsers, hint: "Roster and categories" },
  { path: "/reports", label: "Reports", icon: IconFileDescription, hint: "Print and export" },
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

function NotFound() {
  return (
    <Card>
      <Stack align="center" gap="xs" py="xl">
        <Text fw={600}>Page not found</Text>
        <Text size="sm" c="dimmed">
          That address doesn't match anything in the app.
        </Text>
        <Button component={Link} to="/log" variant="default" mt="xs">
          Go to Log
        </Button>
      </Stack>
    </Card>
  );
}

/**
 * Exhaustive by construction — the union in router.tsx has no default case, so
 * adding a route is a compile error until it is rendered somewhere.
 */
function CurrentPage(): ReactNode {
  const route = useRoute();
  switch (route.page) {
    case "log":
      return <LogPage />;
    case "dashboard":
      return <DashboardPage />;
    case "students":
      return <StudentsPage />;
    case "student":
      return <StudentPage studentId={route.studentId} />;
    case "reports":
      return <ReportsPage />;
    case "notFound":
      return <NotFound />;
  }
}

function NavItem({ item }: { item: (typeof NAV)[number] }) {
  const active = useIsActive(item.path);
  return (
    <NavLink
      component={Link}
      to={item.path}
      active={active}
      label={item.label}
      description={item.hint}
      leftSection={<item.icon size={18} stroke={1.6} />}
      variant="light"
      mb={2}
    />
  );
}

function Shell() {
  const { pathname } = useLocation();
  const [mobileOpened, mobile] = useDisclosure(false);
  const [desktopOpened, desktop] = useDisclosure(true);

  useEffect(() => {
    // "/" is the URL the compiled binary opens; give it a real route so the nav
    // highlight and any later deep link agree on where we are.
    if (pathname === "/") navigate("/log", { replace: true });
    mobile.close();
    window.scrollTo(0, 0);
    // `mobile` is a stable disclosure handle; re-running on it would fight the burger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

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
            <NavItem key={item.path} item={item} />
          ))}
        </AppShell.Section>
        <AppShell.Section>
          <Text size="xs" c="dimmed" ta="center">
            Saved locally on this computer
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <ConflictAlert />
        <CurrentPage />
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
