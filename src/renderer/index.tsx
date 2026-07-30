// First, and ahead of the stylesheets it exists to get in front of.
import "./color-scheme.ts";

// Order matters: Mantine core first, then package styles, then app overrides.
import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/tiptap/styles.css";
import "./app.css";

import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
