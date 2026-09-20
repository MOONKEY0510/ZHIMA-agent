import { describe, expect, it } from "vitest";
import { buildAttachmentBlocks, formatChars, splitAttachments } from "../attachments";

describe("document attachment blocks (P1-8)", () => {
  it("round-trips blocks and the prompt", () => {
    const docs = [
      { name: "报告.docx", chars: 12, text: "第一行\n第二行" },
      { name: "表格.xlsx", chars: 4, text: "a\tb" },
    ];
    const content = `${buildAttachmentBlocks(docs)}\n\n请总结这两份材料`;

    const { blocks, prompt } = splitAttachments(content);

    expect(blocks.map((block) => block.name)).toEqual(["报告.docx", "表格.xlsx"]);
    expect(blocks[0].text).toBe("第一行\n第二行");
    expect(blocks[1].text).toBe("a\tb");
    expect(prompt).toBe("请总结这两份材料");
  });

  it("leaves plain messages untouched", () => {
    const { blocks, prompt } = splitAttachments("普通消息");
    expect(blocks).toEqual([]);
    expect(prompt).toBe("普通消息");
  });

  it("handles an attachment-only message", () => {
    const content = buildAttachmentBlocks([{ name: "a.txt", chars: 2, text: "hi" }]);
    const { blocks, prompt } = splitAttachments(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("a.txt");
    expect(prompt).toBe("");
  });

  it("formats character counts with a thousands separator", () => {
    expect(formatChars(8200)).toBe("8,200 字");
  });
});
