import "server-only";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { applyImportedProfile } from "@/lib/profile-import-apply";
import { importedProfileSchema, importCounts } from "@/lib/profile-import";
import { prisma } from "@/lib/prisma";

import { failure, text } from "./responses";

const short = z.string().max(500);
const prose = z.string().max(20_000);
const span = {
  startYear: z.number().int().min(1900).max(2100).nullable().default(null),
  startMonth: z.number().int().min(1).max(12).nullable().default(null),
  endYear: z.number().int().min(1900).max(2100).nullable().default(null),
  endMonth: z.number().int().min(1).max(12).nullable().default(null),
  current: z.boolean().default(false),
  unverified: z.array(short).max(100).default([]),
};
const skills = z.array(z.string().trim().min(1).max(100)).max(200).default([]);

/** The normal import format, with bounded inputs and defaults for fields a CV omits. */
export const connectorProfileSchema = z.object({
  basics: z.object({
    name: short.optional(), headline: short.optional(), summary: z.string().max(5_000).optional(),
    email: z.string().max(320).optional(), phone: z.string().max(60).optional(),
    dob: z.union([z.literal(""), z.iso.date()]).optional(),
    website: short.optional(), address: short.optional(), city: short.optional(), country: short.optional(), linkedin: short.optional(),
  }).strict().default({}),
  skills: z.array(z.object({ name: z.string().trim().min(1).max(100), found: z.boolean().default(true) })).max(200).default([]),
  languages: z.array(z.object({ name: short, level: importedProfileSchema.shape.languages.element.shape.level, levelGiven: z.boolean().default(true) })).max(50).default([]),
  experience: z.array(z.object({ role: short, company: short, location: short.default(""), bullets: prose.default(""), skills, ...span })).max(100).default([]),
  projects: z.array(z.object({ name: short, link: short.default(""), bullets: prose.default(""), skills, ...span })).max(100).default([]),
  education: z.array(z.object({ degree: short, school: short, notes: prose.default(""), ...span })).max(100).default([]),
  publications: z.array(z.object({ citation: prose, link: short.default(""), unverified: span.unverified })).max(100).default([]),
  references: z.array(z.object({ name: short, relation: short.default(""), company: short.default(""), email: short.default(""), phone: short.default(""), unverified: span.unverified })).max(50).default([]),
});

const PREVIEW_TYPE = "connector-profile-preview";
const DAY = 24 * 60 * 60 * 1000;

export function registerProfileTools(server: McpServer, origin: string): void {
  server.registerTool("preview_profile_update", {
    title: "Preview a profile update from a CV",
    description: "Read the user's CV in Claude and supply the structured facts here. No Dossier AI provider is needed. Only include facts supplied by the user; leave missing fields out. This saves a preview, not the profile. Show the returned preview to the user and get their approval before apply_profile_update. Existing entries are merged, never deleted.",
    inputSchema: z.object({ profile: connectorProfileSchema }),
    annotations: { readOnlyHint: false },
  }, async ({ profile }) => {
    if (Object.keys(profile.basics).length === 0 && ![profile.skills, profile.languages, profile.experience, profile.projects, profile.education, profile.publications, profile.references].some((items) => items.length)) {
      return failure("The profile update is empty. Read the CV or ask the user for their details first.");
    }
    const preview = await prisma.job.create({ data: { type: PREVIEW_TYPE, status: "DONE", input: {}, result: profile, finishedAt: new Date() } });
    return text({ preview_id: preview.id, summary: importCounts(profile), profile, expires_in_hours: 24, next: "Show these changes to the user. After they approve, call apply_profile_update with this preview_id and approved: true." });
  });

  server.registerTool("apply_profile_update", {
    title: "Apply an approved profile update",
    description: "Merge a preview into the career profile after the user has reviewed and approved it. Updates matching roles, projects and degrees and adds new entries. Omitted entries remain. Never invent facts or call this before approval. No AI provider is required.",
    inputSchema: z.object({ preview_id: z.string().min(1).max(100), approved: z.literal(true) }),
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async ({ preview_id }) => {
    return prisma.$transaction(async (tx) => {
      // Concurrent retries of the same approval must not create duplicate entries.
      await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${preview_id} FOR UPDATE`;
      const preview = await tx.job.findUnique({ where: { id: preview_id } });
      if (!preview || preview.type !== PREVIEW_TYPE || Date.now() - preview.createdAt.getTime() > DAY) return failure("That profile preview is missing or expired. Create a new preview.");
      if (preview.step === "applied") return text({ applied: true, already_applied: true, link: `${origin}/profile` });
      const profile = connectorProfileSchema.safeParse(preview.result);
      if (!profile.success) return failure("That profile preview couldn't be read. Create a new preview.");
      await applyImportedProfile(tx, profile.data, "merge");
      // Retain only the receipt. The CV's private details need not remain in a job.
      await tx.job.update({ where: { id: preview_id }, data: { result: {}, step: "applied" } });
      return text({ applied: true, summary: importCounts(profile.data), link: `${origin}/profile`, next: "Read get_profile for the IDs to use when writing applications." });
    }, { timeout: 30_000, maxWait: 10_000 });
  });
}
