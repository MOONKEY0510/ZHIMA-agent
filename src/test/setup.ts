/// <reference types="@testing-library/jest-dom" />
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

// Register jest-dom matchers (toBeNull, toHaveTextContent, etc.) on vitest's
// expect.  The `@testing-library/jest-dom/vitest` subpath entry is
// incompatible with vitest 4.x — it accesses an internal `config` property
// that is not yet initialised during setup-file execution.
expect.extend(matchers);

// jsdom provides requestAnimationFrame; ResizeObserver is the one browser
// API it does not implement, so components that size themselves against
// their container (e.g. the empty-state suggestion row) need this stub.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Tauri bridge modules are mocked per test file where they are exercised.
