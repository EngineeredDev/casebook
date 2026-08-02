import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Burger,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  MantineProvider,
  Modal,
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
  IconFileImport,
  IconMoon,
  IconPencilPlus,
  IconSettings,
  IconSun,
  IconTags,
  IconTimeline,
  IconUsers,
} from "@tabler/icons-react";
import { theme } from "./theme.tsx";
import { api } from "./lib/api.ts";
import { describeElapsed } from "./lib/snapshots.ts";
import { StoreProvider, useStore } from "./store.tsx";
import { Link, navigate, useIsActive, useLocation, useRoute } from "./lib/router.tsx";
import { LogPage } from "./components/LogPage.tsx";
import { TimelinePage } from "./components/TimelinePage.tsx";
import { DashboardPage } from "./components/DashboardPage.tsx";
import { StudentsPage } from "./components/StudentsPage.tsx";
import { StudentPage } from "./components/StudentPage.tsx";
import { CategoriesPage } from "./components/CategoriesPage.tsx";
import { ReportsPage } from "./components/ReportsPage.tsx";
import { ImportPage } from "./components/ImportPage.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { ImportOldData } from "./components/ImportOldData.tsx";

type NavEntry = { path: string; label: string; icon: typeof IconPencilPlus; hint: string };

const NAV: NavEntry[] = [
  { path: "/log", label: "Log", icon: IconPencilPlus, hint: "Record time" },
  { path: "/timeline", label: "Timeline", icon: IconTimeline, hint: "Search all history" },
  { path: "/dashboard", label: "Dashboard", icon: IconChartBar, hint: "Charts and totals" },
  { path: "/students", label: "Students", icon: IconUsers, hint: "Roster and totals" },
  { path: "/categories", label: "Categories", icon: IconTags, hint: "Edit and archive" },
  { path: "/reports", label: "Reports", icon: IconFileDescription, hint: "Print and export" },
  { path: "/import", label: "Import", icon: IconFileImport, hint: "Bring in a document" },
];

/** Sits below the main list rather than in it — it is about the app, not the work. */
const SETTINGS_NAV: NavEntry = {
  path: "/settings",
  label: "Settings",
  icon: IconSettings,
  hint: "Data folder",
};

/**
 * The app mark: an open book whose two pages carry the direct and indirect
 * series colors, so the logo can never drift from the charts. Decorative — the
 * wordmark beside it already says "Casebook".
 *
 * The favicon in src/index.html inlines these same two paths; edit both.
 */
function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      <path
        d="M14.7 9.4C12 6.6 8.2 5.4 4 5.8a1 1 0 0 0-.9 1v15.7a1 1 0 0 0 1.1 1c3.6-.3 7 .8 9.3 3 .5.5 1.2.1 1.2-.6z"
        fill="var(--direct)"
      />
      <path
        d="M17.3 9.4c2.7-2.8 6.5-4 10.7-3.6a1 1 0 0 1 .9 1v15.7a1 1 0 0 1-1.1 1c-3.6-.3-7 .8-9.3 3-.5.5-1.2.1-1.2-.6z"
        fill="var(--indirect)"
      />
    </svg>
  );
}

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
  if (saveState === "retrying") {
    return (
      <Badge color="yellow" variant="light" size="sm" leftSection={<IconAlertTriangle size={12} />}>
        Retrying…
      </Badge>
    );
  }
  if (saveState === "blocked") {
    return (
      <Badge color="orange" variant="light" size="sm" leftSection={<IconAlertTriangle size={12} />}>
        Not saved
      </Badge>
    );
  }
  return (
    <Badge color="red" variant="light" size="sm" leftSection={<IconAlertTriangle size={12} />}>
      {saveState === "conflict" ? "Conflict" : "Save failed"}
    </Badge>
  );
}

/**
 * The deletion tripwire, asking.
 *
 * Casebook removes one entry at a time and has no "delete everything"
 * anywhere, so a save that would take out a fifth of the log did not get that
 * way by being edited. The main process refuses it and this asks; nothing has
 * been written either way, so the cost of a false alarm is one dialog and the
 * cost of a real one is nothing at all.
 */
function DeletionGuard() {
  const { pendingDeletion, confirmDeletion, cancelDeletion } = useStore();
  if (!pendingDeletion) return null;

  const lost = [
    pendingDeletion.entries > 0 ? `${pendingDeletion.entries} entries` : null,
    pendingDeletion.students > 0 ? `${pendingDeletion.students} students` : null,
  ].filter(Boolean);

  return (
    <Modal
      opened
      onClose={cancelDeletion}
      title="That's a lot to remove at once"
      centered
      className="no-print"
    >
      <Stack gap="md">
        <Text size="sm">
          Saving this would remove <strong>{lost.join(" and ")}</strong> from your records. Casebook
          only deletes one thing at a time, so this is unusual enough to check.
        </Text>
        <Text size="sm" c="dimmed">
          Nothing has been saved yet. If this wasn't deliberate, keep the file as it is — everything
          is still there.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={cancelDeletion}>
            Don't save
          </Button>
          <Button color="red" onClick={confirmDeletion}>
            Yes, remove them
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Shown after the dialog above is dismissed without answering. The edits are
 * still in the window and still unsaved; the file is untouched, so reloading is
 * the move that puts everything back.
 */
function BlockedAlert() {
  const { saveState, pendingDeletion, reload } = useStore();
  if (saveState !== "blocked" || pendingDeletion) return null;
  return (
    <Alert
      color="orange"
      variant="light"
      icon={<IconAlertTriangle size={18} />}
      title="These changes haven't been saved"
      mb="md"
      className="no-print"
    >
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          Casebook stopped a save that would have removed a lot of records at once. Your data file
          still has everything in it — reload to go back to it.
        </Text>
        <Button size="xs" color="orange" onClick={reload} style={{ flex: "none" }}>
          Reload data
        </Button>
      </Group>
    </Alert>
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

/**
 * The data file moved on without this window, so the two disagree about what
 * the latest version is and only a person can say which one wins. Rare now that
 * only one Casebook runs at a time — it takes the file changing underneath the
 * app, which an import does on purpose — but it still needs an explicit choice,
 * so it gets a persistent alert rather than a toast.
 */
function ConflictAlert() {
  const { saveState, reload } = useStore();
  useEffect(() => {
    if (saveState !== "conflict") return;
    notifications.show({
      id: "conflict",
      color: "red",
      title: "Your data file changed",
      message: "Reload to pick up the latest version.",
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
      title="Your data file changed underneath this window"
      mb="md"
      className="no-print"
    >
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          Reload to pick up the latest version. Unsaved edits in this window will be lost.
        </Text>
        <Button size="xs" color="red" onClick={reload} style={{ flex: "none" }}>
          Reload data
        </Button>
      </Group>
    </Alert>
  );
}

/**
 * Shown once the retries have stopped. The edits are still in the page and
 * still get saved if a later attempt lands — but nothing will attempt again on
 * its own, so this has to be the thing that says so and offers the retry.
 */
function SaveErrorAlert() {
  const { saveState, retrySave } = useStore();
  if (saveState !== "error") return null;
  return (
    <Alert
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={18} />}
      title="Your changes aren't saved"
      mb="md"
      className="no-print"
    >
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          Casebook couldn't write to your data file. Your edits are still here — leave the app open
          and try again.
        </Text>
        <Button size="xs" color="red" onClick={retrySave} style={{ flex: "none" }}>
          Try again
        </Button>
      </Group>
    </Alert>
  );
}

/**
 * The one time the second location speaks up on its own.
 *
 * The mirror is a bonus copy, not a dependency: an unplugged drive is silent,
 * a failed pass is silent, and nothing about it ever blocks a save or interrupts
 * a session. But a drive that has been unplugged for a fortnight has quietly
 * stopped being a backup, and the whole point of it is the day the Mac is gone —
 * so exactly once, past a week, it says so. Dismissible, and never red.
 */
function MirrorStaleBanner() {
  const [stale, setStale] = useState<{ dir: string; since: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    api()
      .getMirrorState()
      .then((mirror) => {
        if (mirror.stale && mirror.dir) setStale({ dir: mirror.dir, since: mirror.lastSuccessAt });
      })
      // Nothing here is worth a message of its own. The Backups panel says the
      // same thing in more detail whenever she looks.
      .catch(() => undefined);
  }, []);

  if (!stale || dismissed) return null;
  return (
    <Alert
      color="yellow"
      variant="light"
      icon={<IconAlertTriangle size={18} />}
      title="Your second copy hasn't been updated in a while"
      mb="md"
      withCloseButton
      onClose={() => setDismissed(true)}
      className="no-print"
    >
      <Text size="sm">
        Casebook last copied your backups to <Code>{stale.dir}</Code> {describeElapsed(stale.since)}
        . If that's an external drive, plugging it in is all it needs — everything on this Mac is
        still saved as usual.
      </Text>
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
    case "timeline":
      return <TimelinePage />;
    case "dashboard":
      return <DashboardPage />;
    case "students":
      return <StudentsPage />;
    case "student":
      return <StudentPage studentId={route.studentId} />;
    case "categories":
      return <CategoriesPage />;
    case "reports":
      return <ReportsPage />;
    case "import":
      return <ImportPage />;
    case "settings":
      return <SettingsPage />;
    case "notFound":
      return <NotFound />;
  }
}

function NavItem({ item }: { item: NavEntry }) {
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
          <Logo />
          <Text fw={600} size="sm">
            Casebook
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
          <NavItem item={SETTINGS_NAV} />
          <Text size="xs" c="dimmed" ta="center" mt="xs">
            Saved locally on this computer
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <ConflictAlert />
        <SaveErrorAlert />
        <BlockedAlert />
        <MirrorStaleBanner />
        <CurrentPage />
        <ImportOldData />
        <DeletionGuard />
      </AppShell.Main>
    </AppShell>
  );
}

/**
 * The render-error sibling of RecoveryScreen, and the reason it exists is that
 * there is nowhere else for one to go.
 *
 * A browser tab that white-screens still has devtools, a reload button and an
 * address bar. This window has none of them: a single uncaught error anywhere
 * in the tree unmounts everything and leaves a grey rectangle with no way to
 * find out what happened and no way to get back in — on a school-managed Mac,
 * to someone whose next move would otherwise be deciding the app has eaten a
 * year of work. Her data is untouched by any of this; it is on disk, and the
 * folder button proves it by opening the folder it is sitting in.
 *
 * Deliberately a class with nothing in it. componentDidCatch is the only way
 * React offers to catch this at all, and everything else here — no store, no
 * bridge call on mount, no hooks — is because whatever broke the app is
 * upstream of this component and must not be able to break it too.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // The main process pipes this to the terminal in a dev build, and it is the
    // only trace that survives — nobody is going to read a stack trace off this
    // screen, and asking her to open devtools to fetch one is not a plan.
    console.error("Casebook stopped rendering:", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Center h="100vh" p="md">
        <Card maw={560} w="100%" withBorder>
          <Stack gap="md">
            <Group gap="xs" wrap="nowrap">
              <IconAlertTriangle size={20} color="var(--mantine-color-red-6)" />
              <Text fw={600}>Casebook hit a problem and stopped</Text>
            </Group>

            <Text size="sm" c="dimmed">
              Something went wrong while drawing this screen. Nothing has been deleted — your
              records are in their file on this Mac, exactly as they were at the last save.
              Reloading starts the window again and usually clears it.
            </Text>

            <Code block>{error.message || String(error)}</Code>

            <Text size="xs" c="dimmed">
              If it keeps happening on the same page, the data folder holds your records and your
              backups; a backup can be restored from Settings once Casebook opens again.
            </Text>

            <Group gap="xs">
              <Button onClick={() => window.location.reload()}>Reload Casebook</Button>
              <Button
                variant="subtle"
                onClick={() => {
                  // The bridge is one of the things that can be broken by the
                  // time we are here, and `api()` throws when it is missing —
                  // which would take down the last screen still standing.
                  try {
                    void api().revealDataFolder();
                  } catch {
                    /* Then there is nothing this button can do, and saying so
                       is not worth a second failure state on this screen. */
                  }
                }}
              >
                Show data folder in Finder
              </Button>
            </Group>
          </Stack>
        </Card>
      </Center>
    );
  }
}

export function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="top-right" />
      {/* Inside the provider so the screen above can be built out of the same
          components as every other screen, and outside the store so it still
          appears when what threw was the store, a page, or the shell. */}
      <ErrorBoundary>
        <StoreProvider>
          <Shell />
        </StoreProvider>
      </ErrorBoundary>
    </MantineProvider>
  );
}
