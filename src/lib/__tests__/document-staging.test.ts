import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentStager, MAX_DOCUMENTS, MAX_DOCUMENT_CHARS, type StagedDocument } from "../document-staging";
import { parseDocumentPreview, type DocumentPreview } from "../../services/document-api";
vi.mock("../../services/document-api", () => ({ parseDocumentPreview: vi.fn() }));
const preview = (name: string, text = "body"): DocumentPreview => ({ name, text, chars: text.length, totalChars: text.length, truncated: false });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => vi.resetAllMocks());

describe("bounded document staging", () => {
  it("caps total count across batches and runs at most two parsers", async () => {
    const finish: ((value: DocumentPreview) => void)[] = [];
    vi.mocked(parseDocumentPreview).mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    let docs: StagedDocument[] = [];
    const stage = createDocumentStager((value) => { docs = value; }, () => true);
    expect(stage.stage(Array.from({ length: 10 }, (_, i) => `${i}.txt`))).toBe(2);
    expect(docs).toHaveLength(MAX_DOCUMENTS);
    expect(parseDocumentPreview).toHaveBeenCalledTimes(2);
    expect(docs.filter((doc) => doc.status === "queued")).toHaveLength(6);
    finish[0](preview("0.txt"));
    await flush();
    expect(parseDocumentPreview).toHaveBeenCalledTimes(3);
    expect(stage.stage(["extra.txt"])).toBe(1);
  });
  it("enforces the total text budget and reports per-file errors/truncation", async () => {
    vi.mocked(parseDocumentPreview).mockImplementation(async (path) => {
      if (path === "bad") throw new Error("fixture parse failure");
      return preview(path, "x".repeat(40_000));
    });
    let docs: StagedDocument[] = [];
    const stage = createDocumentStager((value) => { docs = value; }, () => true);
    stage.stage(["one", "two", "bad", "over-budget"]);
    await flush();
    expect(docs.reduce((total, doc) => total + doc.text.length, 0)).toBe(MAX_DOCUMENT_CHARS);
    expect(docs[1].notice).toContain("已截断");
    expect(docs[2]).toMatchObject({ status: "error", notice: "fixture parse failure", text: "" });
    expect(docs[3].notice).toContain("总文本预算");
    expect(stage.busy()).toBe(false);
  });
  it("does not deduplicate different files sharing a basename", async () => {
    vi.mocked(parseDocumentPreview).mockImplementation(async (path) => preview("same.txt", path));
    let docs: StagedDocument[] = [];
    const stage = createDocumentStager((value) => { docs = value; }, () => true);
    stage.stage(["/a/same.txt", "/b/same.txt"]);
    await flush();
    expect(docs).toHaveLength(2);
    expect(docs.map((doc) => doc.text)).toEqual(["/a/same.txt", "/b/same.txt"]);
  });
  it("does not resurrect removed attachments and stops queued work when scope expires", async () => {
    let finish!: (value: DocumentPreview) => void;
    vi.mocked(parseDocumentPreview).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    let current = true;
    let docs: StagedDocument[] = [];
    const stage = createDocumentStager((value) => { docs = value; }, () => current);
    stage.stage(["one", "two", "three"]);
    stage.remove(docs[0].id);
    current = false;
    const snapshot = docs;
    finish(preview("stale"));
    await flush();
    expect(parseDocumentPreview).toHaveBeenCalledTimes(2);
    expect(docs).toBe(snapshot);
    expect(docs.some((doc) => doc.name === "stale")).toBe(false);
  });
});
