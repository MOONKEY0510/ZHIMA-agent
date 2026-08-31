import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./styles/tokens.css";
import "./styles/globals.css";
import "./styles/settings.css";

// Apply the saved theme as early as possible to avoid a flash of unstyled
// (transparent) content before React mounts and the settings store loads.
(function applyInitialTheme() {
  try {
    const mode = localStorage.getItem("cf:theme") || "system";
    const resolved =
      mode === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : mode;
    document.documentElement.dataset.theme = resolved;
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
