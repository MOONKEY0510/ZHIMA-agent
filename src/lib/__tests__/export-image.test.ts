import { describe, expect, it } from "vitest";
import { base64ToBytes, fileStamp } from "../export-image";
import { isPrinting, subscribePrinting, withExpandedList } from "../print";

describe("image export helpers (P1-11.2)", () => {
  it("decodes a base64 payload into bytes", () => {
    // "PNG" plus a NUL byte, base64-encoded.
    expect(Array.from(base64ToBytes("UE5HAA=="))).toEqual([0x50, 0x4e, 0x47, 0x00]);
    expect(base64ToBytes("").length).toBe(0);
  });

  it("stamps file names with a compact timestamp", () => {
    expect(fileStamp(new Date(2026, 8, 17, 9, 5))).toBe("20260917-0905");
  });
});

describe("print state (P1-11.3)", () => {
  it("expands the list for the duration of a task", async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribePrinting(() => seen.push(isPrinting()));

    let duringTask = false;
    await withExpandedList(async () => {
      duringTask = isPrinting();
    });

    expect(duringTask).toBe(true);
    expect(isPrinting()).toBe(false);
    expect(seen).toEqual([true, false]);
    unsubscribe();
  });
});
