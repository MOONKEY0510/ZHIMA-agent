import { describe, expect, it } from "vitest";
import {
  assistantToolPolicies,
  serializeToolPolicies,
  type AssistantView,
} from "../assistants-api";

function assistantWith(toolPoliciesJson: string | null): AssistantView {
  return {
    id: "a1",
    name: "测试助手",
    icon: null,
    description: null,
    systemPrompt: "你是测试助手",
    providerId: null,
    modelKey: null,
    toolPoliciesJson,
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("assistant tool policies", () => {
  it("keeps known policy values and ignores everything else", () => {
    const policies = assistantToolPolicies(
      assistantWith('{"read_clipboard":"confirm","web_search":"disabled","bad":"nonsense"}'),
    );
    expect(policies).toEqual({ read_clipboard: "confirm", web_search: "disabled" });
  });

  it("degrades to an empty map for absent or corrupted payloads", () => {
    expect(assistantToolPolicies(assistantWith(null))).toEqual({});
    expect(assistantToolPolicies(assistantWith("not json"))).toEqual({});
    expect(assistantToolPolicies(assistantWith('"just a string"'))).toEqual({});
  });

  it("serializes overrides and turns an empty map into null", () => {
    expect(serializeToolPolicies({ read_pdf: "disabled" })).toBe('{"read_pdf":"disabled"}');
    expect(serializeToolPolicies({})).toBeNull();
  });
});
