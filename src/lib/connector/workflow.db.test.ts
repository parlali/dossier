import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";
import { seedBuiltIns } from "../../../prisma/seed/built-ins";
import { seedDemo } from "../../../prisma/seed/demo";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => false }));
const fake = vi.hoisted(() => ({ sourceFailure: "", searches: [] as string[] }));
vi.mock("@/lib/job-search/find", () => ({
  fullText: async () => "Full job description",
  askSource: vi.fn(async (_query, { source }: { source: string }) => {
    fake.searches.push(source);
    if (source === fake.sourceFailure) return { ok: false, problem: "no-key", message: "Enter the source key in Settings → Job search." };
    return { ok: true, source, postings: [
      { source, externalId: "same-job", title: "Product Designer", company: "Acme", place: "Berlin", remote: true, salary: "", postedAt: null, url: `https://jobs.example/acme?utm_source=${source}`, via: "", description: "Figma and design systems", complete: true },
      { source, externalId: `${source}-unique`, title: "Designer", company: source, place: "Berlin", remote: false, salary: "", postedAt: null, url: `https://jobs.example/${source}`, via: "", description: "Design role", complete: true },
    ], next: null };
  }),
}));
vi.mock("@/lib/startups/refresh", () => ({ startStartupsRefresh: vi.fn(async () => "startup-refresh") }));
vi.mock("@/lib/google/availability", () => ({ syncInterviewToCalendar: vi.fn(async () => ({ inCalendar: false, eventLink: null })) }));
vi.mock("@/lib/page-limit", async (original) => ({ ...(await original<typeof import("@/lib/page-limit")>()), fitResumeToPages: vi.fn(async () => ({ trimmed: [], fits: true })) }));

import { POST } from "@/app/api/mcp/route";
import { challengeOf, exchangeCode, issueCode, registerClient } from "./oauth";

const prisma = () => db.client!;
let token = "";
const call = async (method: string, params: object, credential = token) => {
  const response = await POST(new Request("https://dossier.example/api/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  if (response.status !== 200) return { status: response.status };
  const body = await response.text();
  return JSON.parse(body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
};
const tool = async (name: string, args: object = {}) => {
  const response = await call("tools/call", { name, arguments: args });
  if (response.error) return { isError: true, data: response.error, raw: JSON.stringify(response) };
  const raw = response.result.content[0].text;
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { isError: response.result.isError ?? false, data, raw };
};

beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false });
  fake.sourceFailure = ""; fake.searches = [];
  const clientId = await registerClient({ name: "Existing Claude connection", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: "https://claude.ai/api/mcp/auth_callback", verifier })).access_token;
});
afterAll(() => prisma().$disconnect());

describe("Claude-driven workflow with the existing OAuth grant and no AI provider", () => {
  it("adds write tools to the existing grant without opening unauthenticated access", async () => {
    expect((await call("tools/list", {}, "invalid")).status).toBe(401);
    const names = (await call("tools/list", {})).result.tools.map((entry: { name: string }) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["get_profile", "preview_profile_update", "apply_profile_update", "find_opportunities", "list_startups", "get_pipeline", "record_application_update", "update_application_documents", "set_job_status"]));
    expect((await tool("get_setup_status")).data.available_sources).toContain("STARTUPS");
  });

  it("previews a CV, requires approval, then merges it without deleting existing profile data or invalidating the OAuth grant", async () => {
    const oldRoles = await prisma().experience.count();
    const before = await prisma().setting.findUniqueOrThrow({ where: { key: "connectorEnabledAt" } });
    const proposed = await tool("preview_profile_update", { profile: { basics: { headline: "Principal Designer", email: "private@example.com" }, skills: [{ name: "New CV skill" }], experience: [{ role: "Principal Designer", company: "New CV employer", bullets: "Built an accessible product" }] } });
    expect(proposed.isError).toBe(false);
    expect(await prisma().profileField.findUnique({ where: { key: "headline" } })).not.toMatchObject({ value: "Principal Designer" });
    expect((await tool("apply_profile_update", { preview_id: proposed.data.preview_id, approved: false })).isError).toBe(true);
    expect((await tool("apply_profile_update", { preview_id: proposed.data.preview_id, approved: true })).data.applied).toBe(true);
    expect(await prisma().experience.count()).toBe(oldRoles + 1);
    expect((await tool("get_profile")).raw).toContain("Principal Designer");
    expect((await tool("get_profile")).raw).not.toContain("private@example.com");
    expect((await tool("apply_profile_update", { preview_id: proposed.data.preview_id, approved: true })).data.already_applied).toBe(true);
    expect(await prisma().experience.count()).toBe(oldRoles + 1);
    expect((await prisma().setting.findUniqueOrThrow({ where: { key: "connectorEnabledAt" } })).value).toBe(before.value);
    expect((await tool("get_setup_status")).isError).toBe(false);
    expect((await prisma().job.findUniqueOrThrow({ where: { id: proposed.data.preview_id } })).result).toEqual({});
  });

  it("rejects empty, invalid and expired CV updates", async () => {
    expect((await tool("preview_profile_update", { profile: {} })).isError).toBe(true);
    expect((await tool("preview_profile_update", { profile: { basics: { headline: "x".repeat(501) } } })).isError).toBe(true);
    const preview = await tool("preview_profile_update", { profile: { skills: [{ name: "Figma" }] } });
    await prisma().job.update({ where: { id: preview.data.preview_id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    expect((await tool("apply_profile_update", { preview_id: preview.data.preview_id, approved: true })).isError).toBe(true);
  });

  it("applies concurrent retries of one approval only once", async () => {
    const preview = await tool("preview_profile_update", { profile: { experience: [{ role: "Concurrent role", company: "Concurrent employer" }] } });
    const results = await Promise.all([1, 2].map(() => tool("apply_profile_update", { preview_id: preview.data.preview_id, approved: true })));
    expect(results.every((result) => result.data.applied)).toBe(true);
    expect(await prisma().experience.count({ where: { company: "Concurrent employer" } })).toBe(1);
  });

  it("searches both sources even when Find jobs is off, deduplicates cross-source URLs and returns only unseen listings", async () => {
    const first = await tool("find_opportunities", { keywords: "designer", country: "de", sources: ["JSEARCH", "ADZUNA"], limit: 1 });
    expect(first.isError).toBe(false);
    expect(fake.searches).toEqual(["JSEARCH", "ADZUNA"]);
    expect(first.data.jobs).toHaveLength(1);
    expect(first.data.remaining_in_results).toBe(2);
    const second = await tool("find_opportunities", { keywords: "designer", country: "de", sources: ["JSEARCH", "ADZUNA"] });
    expect(second.data.jobs).toHaveLength(2);
    expect(second.data.jobs.every((job: { company: string }) => job.company !== "Acme")).toBe(true);
    const third = await tool("find_opportunities", { keywords: "designer", country: "de", sources: ["JSEARCH", "ADZUNA"] });
    expect(third.data.jobs).toHaveLength(0);
    expect((await tool("find_opportunities", { keywords: "designer", country: "de", sources: ["JSEARCH", "ADZUNA"], new_only: false })).data.jobs).toHaveLength(3);
  });

  it("keeps startup discovery working when a keyed source is unavailable, and supports background progress", async () => {
    fake.sourceFailure = "JSEARCH";
    const found = await tool("find_opportunities", { keywords: "designer", country: "de", sources: ["JSEARCH", "STARTUPS"] });
    expect(found.data.sources[0].message).toContain("Settings");
    expect(found.data.startup_refresh_id).toBe("startup-refresh");
    await prisma().job.create({ data: { id: "startup-refresh", type: "startups-refresh", status: "RUNNING", step: "Fetching", input: {} } });
    expect((await tool("list_startups", { startup_refresh_id: "startup-refresh" })).data.status).toBe("working");
    await prisma().job.update({ where: { id: "startup-refresh" }, data: { status: "DONE", result: {} } });
    await prisma().startup.create({ data: { source: "HN", externalId: "1", company: "New startup", summary: "Remote designer", details: "Hiring a designer", website: "https://startup.example", score: 80, roles: [], emails: [], links: [], reasons: [] } });
    expect((await tool("list_startups", { startup_refresh_id: "startup-refresh" })).data.startups).toHaveLength(1);
    expect((await tool("list_startups")).data.startups).toHaveLength(0);
    expect((await tool("list_startups", { new_only: false })).data.startups).toHaveLength(1);
  });

  it("stores geographic preferences and uses them for discovery without changing the profile or OAuth grant", async () => {
    const profileCountry = await prisma().profileField.findUnique({ where: { key: "country" } });
    const result = await tool("set_job_search_settings", { location_preferences: { on_site_countries: ["gb", "ae"], remote_regions: ["Europe", "MENA"] } });
    expect(result.isError).toBe(false);
    expect((await tool("get_setup_status")).data.search_preferences.remote_regions).toEqual(["Europe", "MENA"]);
    const found = await tool("find_opportunities", { keywords: "designer", sources: ["JSEARCH"], limit: 1 });
    expect(found.data.searched_targets.map((target: { country: string }) => target.country)).toEqual(["gb", "ae", "gb", "ae"]);
    expect(found.data.remaining_in_results).toBe(1);
    const rest = await tool("find_opportunities", { keywords: "designer", sources: ["JSEARCH"] });
    expect(rest.data.country_rotation_page).toBe(0);
    expect(rest.data.jobs).toHaveLength(1);
    expect(rest.data.remaining_in_results).toBe(0);
    const next = await tool("find_opportunities", { keywords: "designer", sources: ["JSEARCH"] });
    expect(next.data.searched_targets.map((target: { country: string }) => target.country)).toEqual(["gb", "ae", "de", "sa"]);
    const explicit = await tool("find_opportunities", { keywords: "designer", country: "fr", remote_only: true, sources: ["JSEARCH"] });
    expect(explicit.data.searched_targets).toHaveLength(1);
    expect(explicit.data.searched_targets[0].country).toBe("fr");
    expect(await prisma().profileField.findUnique({ where: { key: "country" } })).toEqual(profileCountry);
  });

  it("saves and dismisses job listings, and excludes saved and applied-for ones from new discoveries", async () => {
    const found = await tool("find_opportunities", { keywords: "designer", country: "de", sources: ["JSEARCH"] });
    const job = found.data.jobs[0];
    expect((await tool("set_job_status", { search_id: job.search_id, number: job.number, status: "SAVED" })).data.status).toBe("SAVED");
    expect((await tool("find_opportunities", { keywords: "designer", country: "de", sources: ["JSEARCH"], new_only: false })).data.jobs).toHaveLength(1);
    const stored = await prisma().posting.findFirstOrThrow({ where: { externalId: "same-job" } });
    expect((await tool("set_job_status", { posting_id: stored.id, status: "DISMISSED" })).data.status).toBe("DISMISSED");
  });

  it("links a Claude-written application to a startup and refuses to create a second one for the same startup", async () => {
    const startup = await prisma().startup.create({ data: { source: "YC", externalId: "new-startup", company: "Startup employer", summary: "Hiring a designer", details: "Work on design systems", roles: ["Designer"], emails: [], links: [{ label: "Hiring post", url: "https://news.ycombinator.com/item?id=123" }], reasons: [] } });
    expect((await tool("get_posting", { startup_id: startup.id })).data.text).toContain("design systems");
    const args = { startup_id: startup.id, details: { company: startup.company, role: "Designer" }, resume: { summary: "Product designer", roles: [], skills: [] }, cover_letter: { paragraphs: [{ text: "I would like to discuss this design role." }] } };
    const created = await tool("save_application", args);
    expect(created.isError).toBe(false);
    expect((await prisma().startup.findUniqueOrThrow({ where: { id: startup.id } })).applicationId).toBe(created.data.application_id);
    expect((await tool("save_application", args)).data).toMatchObject({ application_id: created.data.application_id, already_exists: true });
    expect(await prisma().application.count({ where: { company: startup.company } })).toBe(1);
  });

  it("records pipeline details, notes, interview dates and stage changes while keeping private notes out of reads", async () => {
    const application = await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } });
    const updated = await tool("record_application_update", { id: application.id, salary: "80k", note: "Private employer conversation", next_interview_at: "2026-11-03T12:00:00.000Z" });
    expect(updated.isError).toBe(false);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: application.id } })).toMatchObject({ salary: "80k", nextInterviewAt: new Date("2026-11-03T12:00:00Z") });
    expect((await tool("set_application_status", { id: application.id, status: "INTERVIEW" })).isError).toBe(false);
    const pipeline = await tool("get_pipeline");
    expect(pipeline.data.applications.find((row: { id: string }) => row.id === application.id)).toMatchObject({ status: "Interview", nextInterviewAt: "2026-11-03T12:00:00.000Z" });
    expect(pipeline.raw).not.toContain("Private employer conversation");
    expect((await tool("record_application_update", { id: "gone", note: "test" })).isError).toBe(true);
    expect((await tool("record_application_update", { id: application.id })).isError).toBe(true);
  });

  it("revises saved documents with version history and private framing, without creating another application", async () => {
    const application = await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" }, include: { documents: true } });
    const before = await prisma().application.count();
    const letterBefore = application.documents.find((doc) => doc.kind === "COVER_LETTER")!;
    const result = await tool("update_application_documents", { id: application.id, cover_letter: { paragraphs: [{ text: "Updated cover letter from Claude." }] } });
    expect(result.isError).toBe(false);
    expect(await prisma().application.count()).toBe(before);
    const letterAfter = await prisma().document.findUniqueOrThrow({ where: { id: letterBefore.id } });
    expect(JSON.stringify(letterAfter.units)).toContain("Updated cover letter from Claude.");
    const privateParts = (units: unknown) => (units as { id: string; text: string }[]).filter((unit) => ["sender", "signature"].includes(unit.id));
    expect(privateParts(letterAfter.units)).toEqual(privateParts(letterBefore.units));
    expect(await prisma().documentVersion.count({ where: { documentId: letterBefore.id, cause: "REFINED" } })).toBe(1);
  });

  it("allows changing non-secret search settings without exposing keys or changing connector authentication", async () => {
    await saveSettings({ jsearchKeyEnc: "do-not-expose-this", adzunaAppId: "example" });
    const result = await tool("set_job_search_settings", { source: "ADZUNA", adzuna_app_id: "new-app" });
    expect(result.isError).toBe(false);
    expect(result.raw).not.toContain("do-not-expose-this");
    expect(result.data.sources.source).toBe("ADZUNA");
    expect((await tool("set_job_search_settings", { source: "ARBEITSAGENTUR" })).isError).toBe(true);
    expect((await call("tools/list", {})).result.tools.length).toBeGreaterThan(20);
  });
});
