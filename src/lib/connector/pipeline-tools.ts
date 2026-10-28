import "server-only";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { guardSources, guardUnits } from "@/lib/ai/fact-guard";
import { resumeUnits } from "@/lib/ai/tasks/tailor-resume";
import { extractedSchema } from "@/lib/application-data";
import { documentLabels } from "@/lib/document-labels";
import { updateDocuments } from "@/lib/document-units";
import { syncInterviewToCalendar } from "@/lib/google/availability";
import { GoogleError } from "@/lib/google/errors";
import { isFrameUnit, withFrame, type Frame } from "@/lib/letter-frame";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";
import { TONES } from "@/lib/tones";

import { failure, text } from "./responses";
import { letterUnits, writtenLetterSchema, writtenResumeSchema } from "./write";

const id = z.string().min(1).max(100);

export function registerPipelineTools(server: McpServer, origin: string): void {
  server.registerTool("get_pipeline", {
    title: "Summarize the application pipeline",
    description: "Read application progress, recent status history, deadlines and interview dates. Includes records changed since a supplied timestamp. Private notes are always omitted. This reads Dossier's saved records; it does not read email or infer employer responses.",
    inputSchema: z.object({ updated_since: z.iso.datetime().optional(), include_archived: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(30) }),
    annotations: { readOnlyHint: true },
  }, async ({ updated_since, include_archived, limit }) => {
    const asOf = new Date().toISOString();
    const where = { awaitingReview: false, ...(include_archived ? {} : { archivedAt: null }) };
    const [groups, rows] = await Promise.all([
      prisma.application.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.application.findMany({ where: { ...where, ...(updated_since ? { updatedAt: { gte: new Date(updated_since) } } : {}) }, orderBy: { updatedAt: "desc" }, take: limit, select: { id: true, title: true, company: true, role: true, location: true, salary: true, status: true, deadline: true, sentAt: true, nextInterviewAt: true, updatedAt: true, events: { orderBy: { at: "desc" }, take: 5, select: { from: true, to: true, at: true } } } }),
    ]);
    return text({ as_of: asOf, counts: Object.fromEntries(groups.map((group) => [group.status, group._count._all])), applications: rows.map((row) => ({ ...row, status: statusInfo(row.status).label, link: `${origin}/applications/${row.id}` })), next: "Use set_application_status for stage changes, record_application_update for details/notes/interview dates, and update_application_documents to revise saved drafts." });
  });

  server.registerTool("record_application_update", {
    title: "Record an application update",
    description: "Record facts the user supplies about an existing application: details, deadline, next interview, or a new private note. Omitted fields remain unchanged. Never invent an employer reply. Stage changes use set_application_status. An interview date is synced to Google Calendar only if the user already enabled that integration; no email or application is sent.",
    inputSchema: z.object({ id, company: z.string().max(300).optional(), role: z.string().max(300).optional(), location: z.string().max(300).optional(), salary: z.string().max(200).optional(), deadline: z.iso.date().nullable().optional(), next_interview_at: z.iso.datetime().nullable().optional(), note: z.string().trim().min(1).max(5_000).optional() }),
    annotations: { readOnlyHint: false },
  }, async ({ id, note, next_interview_at, deadline, ...details }) => {
    if (!Object.keys(details).length && note === undefined && next_interview_at === undefined && deadline === undefined) return failure("Supply at least one detail, note, deadline or interview date to update.");
    const saved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.application.updateMany({ where: { id }, data: { ...details, updatedAt: new Date(), ...(deadline !== undefined ? { deadline: deadline ? new Date(deadline) : null } : {}), ...(next_interview_at !== undefined ? { nextInterviewAt: next_interview_at ? new Date(next_interview_at) : null } : {}) } });
      if (!count) return false;
      if (note) await tx.note.create({ data: { applicationId: id, body: note } });
      return true;
    });
    if (!saved) return failure("That application no longer exists.");
    let calendar: string | undefined;
    if (next_interview_at !== undefined) {
      try { calendar = (await syncInterviewToCalendar(id)).inCalendar ? "updated" : "not connected or disabled"; }
      catch (error) { if (!(error instanceof GoogleError)) throw error; calendar = "Interview saved, but calendar sync failed. Check the Google integration in Dossier."; }
    }
    return text({ id, saved: true, calendar, link: `${origin}/applications/${id}` });
  });

  server.registerTool("update_application_documents", {
    title: "Revise an existing resume or cover letter",
    description: "Save revised documents written in Claude to an existing application without creating a duplicate. Read get_application and get_profile first. Only use facts from the profile. Omit either document to leave it unchanged. Existing private letter framing and templates are preserved; changed documents get version history. No Dossier AI provider is required.",
    inputSchema: z.object({ id, resume: writtenResumeSchema.optional(), cover_letter: writtenLetterSchema.optional() }),
    annotations: { readOnlyHint: false },
  }, async ({ id, resume, cover_letter }) => {
    if (!resume && !cover_letter) return failure("Supply a revised resume or cover letter.");
    const application = await prisma.application.findUnique({ where: { id } });
    if (!application) return failure("That application no longer exists.");
    const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
    const extracted = extractedSchema.safeParse(application.extracted);
    const sources = guardSources(profile, extracted.success ? extracted.data : null, application.postingText);
    let newResume = resume ? resumeUnits(profile, resume, documentLabels(application.language)) : undefined;
    let newLetter = cover_letter ? letterUnits(cover_letter, cover_letter.sign_off || TONES[application.tone].signOff) : undefined;
    if (settings.strict) {
      if (newResume) newResume = guardUnits(newResume, sources);
      if (newLetter) newLetter = guardUnits(newLetter, sources);
    }
    const result = await updateDocuments(id, async (documents, tx) => {
      if ((newResume && !documents.RESUME) || (newLetter && !documents.COVER_LETTER)) return false;
      if (newResume) documents.RESUME = newResume;
      if (newLetter) documents.COVER_LETTER = withFrame(newLetter, Object.fromEntries(documents.COVER_LETTER!.filter((unit) => isFrameUnit(unit.id)).map((unit) => [unit.id, unit.text])) as Partial<Frame>);
      await tx.application.update({ where: { id }, data: { updatedAt: new Date() } });
      return true;
    }, { version: { cause: "REFINED", detail: "Revised in Claude" } });
    if (!result) return failure("That application has no saved document to revise. Save a full application first.");
    return text({ id, updated: true, check_these: [...(newResume ?? []), ...(newLetter ?? [])].filter((unit) => unit.unverified?.length).map((unit) => ({ part: unit.label, items: unit.unverified })), link: `${origin}/applications/${id}` });
  });
}
