import { invoke } from "@tauri-apps/api/core";

/**
 * User skills (自定义技能): reusable instruction packages the user writes once
 * and the assistant applies when its trigger words match the request.
 *
 * Injection is two-stage (see `src-tauri/src/agent/skills.rs`): the catalog of
 * enabled skills is always present in the system prompt; a skill's full
 * instructions are injected only when triggered (or when it has no triggers).
 */

export interface SkillView {
  id: string;
  name: string;
  description: string;
  /** Instruction body applied when the skill is active. */
  content: string;
  /** Keywords that activate the skill; empty = always active. */
  triggers: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Draft shape for a brand-new skill (empty id → backend mints one). */
export function newSkill(): SkillView {
  return {
    id: "",
    name: "",
    description: "",
    content: "",
    triggers: [],
    enabled: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function listSkills(): Promise<SkillView[]> {
  return invoke<SkillView[]>("list_skills");
}

/** Create (empty id) or update a skill; returns the stored row. */
export function upsertSkill(skill: SkillView): Promise<SkillView> {
  return invoke<SkillView>("upsert_skill", { skill });
}

export function deleteSkill(id: string): Promise<void> {
  return invoke("delete_skill", { id });
}

/** Outcome of one import batch. */
export interface ImportSkillsReport {
  /** Skills created from the imported files. */
  created: number;
  /** Existing skills updated because the file carried the same name. */
  updated: number;
  /** Per-file failures rendered as `文件名：原因`. */
  failed: string[];
}

/**
 * Import skills from files chosen in the native dialog.
 *
 * Accepts `SKILL.md` (YAML frontmatter with name / description / triggers),
 * plain Markdown, JSON (single object, array, or a backup payload) and `.zip`
 * packages containing a `SKILL.md`.  Same-name skills are updated in place.
 */
export function importSkillFiles(paths: string[]): Promise<ImportSkillsReport> {
  return invoke<ImportSkillsReport>("import_skill_files", { paths });
}

/** Split the free-form trigger input ("周报，weekly; 汇报") into keywords. */
export function parseTriggers(input: string): string[] {
  return input
    .split(/[,，、;；\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Render triggers back into the editable single-line form. */
export function formatTriggers(triggers: string[]): string {
  return triggers.join("，");
}
