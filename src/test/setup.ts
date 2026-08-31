/// <reference types="@testing-library/jest-dom" />
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

// Register jest-dom matchers (toBeNull, toHaveTextContent, etc.) on vitest's
// expect.  The `@testing-library/jest-dom/vitest` subpath entry is
// incompatible with vitest 4.x — it accesses an internal `config` property
// that is not yet initialised during setup-file execution.
expect.extend(matchers);

// jsdom provides requestAnimationFrame; nothing else needs global patching.
// Tauri bridge modules are mocked per test file where they are exercised.
