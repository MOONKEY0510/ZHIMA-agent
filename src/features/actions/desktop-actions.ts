import type { DesktopActionConfig, PromptPreset } from "../../stores/settings-store";

export const DEFAULT_DESKTOP_PRESETS: PromptPreset[] = [
  { id: "desktop-summary", name: "总结剪贴板", command: "/剪贴板总结", content: "请用要点总结以下内容：", desktopAction: { source: "clipboard", template: "请用要点总结以下内容：\n\n{{input}}", skillIds: [], output: "display", favorite: true } },
  { id: "desktop-translate", name: "翻译选中文本", command: "/划词翻译", content: "请翻译以下内容：", desktopAction: { source: "selection", template: "请将以下内容翻译为中文；若为中文则翻译为英文：\n\n{{input}}", skillIds: [], output: "copy" } },
  { id: "desktop-polish", name: "润色剪贴板", command: "/剪贴板润色", content: "请润色以下文字：", desktopAction: { source: "clipboard", template: "请润色以下文字，保持原意：\n\n{{input}}", skillIds: [], output: "copy" } },
];

/** Treat input as literal text, never as replacement syntax or executable content. */
export function appendActionTemplate(draft: string, action: DesktopActionConfig, input: string): string {
  const body = action.template.includes("{{input}}")
    ? action.template.replaceAll("{{input}}", () => input)
    : `${action.template}\n\n${input}`;
  return draft ? `${draft}\n\n${body}` : body;
}

export function desktopPresets(presets: PromptPreset[]): (PromptPreset & { desktopAction: DesktopActionConfig })[] {
  return presets.filter((preset): preset is PromptPreset & { desktopAction: DesktopActionConfig } => !!preset.desktopAction)
    .sort((a, b) => Number(!!b.desktopAction.favorite) - Number(!!a.desktopAction.favorite));
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Allowlist for UI prefs loading/export: legacy slash entries remain unchanged.
 * Invalid optional action data is discarded, never interpreted as capabilities.
 * Templates are user-authored text: exports may contain their personal content.
 */
export function sanitizePresets(value: unknown): PromptPreset[] {
  if (!Array.isArray(value)) return [];
  const result: PromptPreset[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!record(item) || !["id", "name", "command", "content"].every((key) => typeof item[key] === "string") || !item.id || ids.has(item.id as string)) continue;
    const preset: PromptPreset = { id: item.id as string, name: item.name as string, command: item.command as string, content: item.content as string };
    ids.add(preset.id);
    const a = item.desktopAction;
    if (record(a) && (a.source === "selection" || a.source === "clipboard") && typeof a.template === "string" && (a.output === "display" || a.output === "copy") && Array.isArray(a.skillIds) && a.skillIds.every((id) => typeof id === "string")) {
      preset.desktopAction = { source: a.source, template: a.template, skillIds: [...new Set(a.skillIds as string[])], output: a.output };
      if (typeof a.assistantId === "string" && a.assistantId) preset.desktopAction.assistantId = a.assistantId;
      if (typeof a.favorite === "boolean") preset.desktopAction.favorite = a.favorite;
    }
    result.push(preset);
  }
  return result;
}
