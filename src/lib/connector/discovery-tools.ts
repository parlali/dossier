import "server-only";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { countryCodeFor } from "@/lib/job-search/countries";
import { credentialsFor, jobSearchView, loadJobSearchConfig } from "@/lib/job-search/config";
import { askSource } from "@/lib/job-search/find";
import { linkKey, postingKey, RADII_KM, type SearchQuery, type FoundPosting } from "@/lib/job-search/search";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { getJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { postingStates } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { saveSettings } from "@/lib/settings-data";
import { placeOf } from "@/lib/startups/place";
import { startStartupsRefresh } from "@/lib/startups/refresh";
import { getStartup, listStartups, startupPostingText, updateStartup } from "@/lib/startups/store";
import { startupFilterSchema } from "@/lib/startups/types";

import { failure, text } from "./responses";
import { unseenItems } from "./seen";
import { advanceLocationPage, loadSearchPreferences, locationPage, REMOTE_COUNTRY_POOLS, saveSearchPreferences, searchPreferencesSchema, searchTargets, startupMatchesPreferences } from "./search-preferences";

const sources = ["JSEARCH", "ADZUNA", "ARBEITSAGENTUR", "STARTUPS"] as const;
const id = z.string().min(1).max(100);
type DiscoveredJob = { search_id: string; number: number; posting: FoundPosting; search_target: string };

export function registerDiscoveryTools(server: McpServer, origin: string): void {
  server.registerTool("get_setup_status", {
    title: "Check profile and discovery setup",
    description: "Reports profile readiness and the state of each job source without revealing API keys. Startup discovery from YC and Hacker News needs no job-source key or AI provider. If other sources need credentials, direct the user to the settings link; never ask for secrets in chat.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true },
  }, async () => {
    const [profile, config, preferences] = await Promise.all([loadProfile(), loadJobSearchConfig(), loadSearchPreferences()]);
    const available = sources.filter((source) => {
      if (source === "STARTUPS") return true;
      if (source === "ARBEITSAGENTUR" && !config.arbeitsagentur.acceptedAt) return false;
      try { credentialsFor(config, source); return true; } catch { return false; }
    });
    return text({
      profile: { headline: profile.basics.headline, city: profile.basics.city, country: profile.basics.country, skills: profile.skills.length, experience: profile.experience.length },
      sources: jobSearchView(config), available_sources: available, search_preferences: preferences, remote_country_pools: REMOTE_COUNTRY_POOLS,
      credentials: { JSEARCH: SOURCE_INFO.JSEARCH.keyUrl, ADZUNA: SOURCE_INFO.ADZUNA.keyUrl },
      settings_link: `${origin}/settings?section=jobs`, profile_link: `${origin}/profile`,
      next: "Use preview_profile_update/apply_profile_update to fill the profile from a CV. Use find_opportunities for discovery without configuring an AI provider. Missing provider keys do not block startups.",
    });
  });

  server.registerTool("set_job_search_settings", {
    title: "Choose a job source and search preferences",
    description: "Set the source used by Dossier's Find jobs screen and non-secret provider options. Can also save on-site countries and remote regions used by find_opportunities and list_startups. Does not change credentials, authentication, AI settings or the daily agent. API keys must be entered in Dossier's settings. Bundesagentur requires prior acceptance of its notice in the app.",
    inputSchema: z.object({ source: z.enum(["OFF", "JSEARCH", "ADZUNA", "ARBEITSAGENTUR"]).optional(), jsearch_host: z.enum(["openwebninja", "rapidapi"]).optional(), adzuna_app_id: z.string().trim().max(200).optional(), location_preferences: searchPreferencesSchema.optional() }),
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async ({ source, jsearch_host, adzuna_app_id, location_preferences }) => {
    const config = await loadJobSearchConfig();
    if (source === "ARBEITSAGENTUR" && (!config.arbeitsagentur.offered || !config.arbeitsagentur.acceptedAt)) return failure("Choose this source and accept its notice yourself in Settings → Job search first.");
    await saveSettings({ ...(source ? { jobSource: source } : {}), ...(jsearch_host ? { jsearchHost: jsearch_host } : {}), ...(adzuna_app_id !== undefined ? { adzunaAppId: adzuna_app_id } : {}) });
    if (location_preferences) await saveSearchPreferences(location_preferences);
    return text({ sources: jobSearchView(await loadJobSearchConfig()), search_preferences: await loadSearchPreferences(), settings_link: `${origin}/settings?section=jobs` });
  });

  server.registerTool("find_opportunities", {
    title: "Find new jobs and startup opportunities",
    description: "Search multiple sources and start a YC/Hacker News startup refresh, without any Dossier AI provider. Defaults to JSearch, Adzuna and Startups; missing credentials are reported per source and don't stop the others. Supply role/keywords and country, or use saved location preferences and the profile role. Saved preferences search all on-site countries and one rotating index country per remote region per run. Report the countries actually searched, not whole-region coverage. Indexed location does not establish remote eligibility; verify that from the full posting. Returns new, not already saved/dismissed/applied-for job listings, deduplicated across providers. Call list_startups with startup_refresh_id to collect startup results. Each provider page consumes its own source quota. Read get_posting, score in Claude and save_job_scores, then save_application for drafts. Never send or apply automatically.",
    inputSchema: z.object({ keywords: z.string().trim().max(200).optional(), place: z.string().max(200).optional(), country: z.string().max(60).optional(), remote_only: z.boolean().optional(), work_mode: z.enum(["onsite", "remote", "any"]).optional(), use_preferences: z.boolean().default(true), location_page: z.number().int().min(0).max(10000).optional(), radius_km: z.literal(RADII_KM).default(25), sources: z.array(z.enum(sources)).min(1).max(4).default(["JSEARCH", "ADZUNA", "STARTUPS"]), new_only: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(30) }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (input) => {
    if (input.work_mode === "onsite" && input.remote_only) return failure("Choose either on-site or remote work, not both.");
    const [profile, preferences] = await Promise.all([loadProfile(), loadSearchPreferences()]);
    const country = countryCodeFor(input.country ?? profile.basics.country) || ((input.country ?? "").length === 2 ? input.country!.toLowerCase() : "");
    const query: SearchQuery = { keywords: input.keywords || profile.basics.headline, place: input.remote_only || input.work_mode === "remote" ? "" : input.place ?? (input.country === undefined ? profile.basics.city : ""), country, radiusKm: input.radius_km, remoteOnly: input.work_mode === "remote" || (input.remote_only ?? false), workMode: input.work_mode ?? (input.remote_only === true ? "remote" : undefined), postedWithin: "any" };
    const useSaved = input.use_preferences && preferences !== null && input.country === undefined && input.place === undefined && input.remote_only === undefined && input.work_mode === undefined;
    const page = input.location_page ?? (useSaved ? await locationPage() : 0);
    const targets = useSaved ? searchTargets(preferences, query, page) : [{ label: country ? `${country.toUpperCase()} ${input.work_mode ?? (query.remoteOnly ? "remote" : "all work modes")}` : "profile defaults", mode: input.work_mode ?? (query.remoteOnly ? "remote" : "any") as "remote" | "onsite" | "any", query }];
    const jobs: DiscoveredJob[] = [];
    const outcomes: { source: string; found: number; target?: string; country?: string; search_id?: string; message?: string }[] = [];
    let startupRefreshId: string | null = null;
    // Providers run independently: slow or unavailable sources don't serialize every country query.
    const results = await Promise.all([...new Set(input.sources)].map(async (source) => {
      const found: DiscoveredJob[] = [];
      const reports: typeof outcomes = [];
      if (source === "STARTUPS") {
        try {
          startupRefreshId = await startStartupsRefresh();
          reports.push({ source, found: 0, message: "Refresh started. Call list_startups with startup_refresh_id until it finishes." });
        } catch (error) {
          logServerError("Claude startup discovery", error);
          reports.push({ source, found: 0, message: "Startup refresh couldn't start. Other sources can still be used." });
        }
        return { found, reports };
      }
      const targetResults = await Promise.all(targets.map(async (target) => {
        const found: DiscoveredJob[] = [];
        const reports: typeof outcomes = [];
        try {
          if (!target.query.keywords.trim()) { reports.push({ source, target: target.label, found: 0, message: "Give keywords or add a headline to the profile." }); return { found, reports }; }
          const answer = await askSource(target.query, { source });
          if (!answer.ok) { reports.push({ source, target: target.label, country: target.query.country, found: 0, message: answer.message }); return { found, reports }; }
          const search = await prisma.postingSearch.create({ data: { source, query: target.query, postings: answer.postings, found: answer.postings.length, next: answer.next } });
          found.push(...answer.postings.map((posting, index) => ({ search_id: search.id, number: index + 1, posting, search_target: target.label })));
          reports.push({ source, target: target.label, country: target.query.country, found: answer.postings.length, search_id: search.id });
        } catch (error) {
          logServerError(`Claude discovery ${source}`, error);
          reports.push({ source, target: target.label, found: 0, message: "This source couldn't be reached. The other sources can still be used." });
        }
        return { found, reports };
      }));
      for (const result of targetResults) { found.push(...result.found); reports.push(...result.reports); }
      return { found, reports };
    }));
    for (const result of results) { jobs.push(...result.found); outcomes.push(...result.reports); }
    const states = await postingStates(jobs.map(({ posting }) => posting));
    const eligible = jobs.filter(({ posting }) => { const state = states.get(postingKey(posting)); return !state?.saved && !state?.dismissed && !state?.applicationId; });
    const selected = await unseenItems("jobs", eligible, ({ posting }) => [postingKey(posting), ...(linkKey(posting.url) ? [`url:${linkKey(posting.url)}`] : [])], input.limit, input.new_only);
    if (useSaved && input.new_only && input.location_page === undefined && selected.remaining === 0 && outcomes.some((outcome) => outcome.search_id)) await advanceLocationPage(page);
    return text({ sources: outcomes, search_preferences: preferences, country_rotation_page: useSaved ? page : undefined, searched_targets: targets.map((target) => ({ label: target.label, country: target.query.country, mode: target.mode })), location_note: "Country is the job index searched, not proof of remote-work eligibility. Read the full posting before claiming a role accepts applicants from Europe/MENA. On-site searches exclude confirmed remote roles; check unclear or hybrid arrangements.", jobs: selected.items.map(({ posting, ...ref }) => ({ ...ref, source: posting.source, title: posting.title, company: posting.company, place: posting.place, remote: posting.remote, salary: posting.salary, posted: posting.postedAt, url: posting.url, snippet: posting.description.replace(/\s+/g, " ").slice(0, 700) })), remaining_in_results: selected.remaining, startup_refresh_id: startupRefreshId, settings_link: `${origin}/settings?section=jobs`, next: startupRefreshId ? "Call list_startups with this startup_refresh_id. Score and shortlist in Claude; no Dossier AI provider is needed." : "Read and score interesting postings in Claude. Use more_jobs with each search_id for the next provider page. With saved preferences, subsequent runs rotate remote-country indexes; explicit country/location arguments override the preferences." });
  });

  server.registerTool("list_startups", {
    title: "Read new YC and Hacker News opportunities",
    description: "Collect a refresh started by find_opportunities or list stored startups. If a refresh is still running, call again later with the same startup_refresh_id. New-only discovery remembers only returned items, so asking again yields the next unseen matches. Startup matching and refresh need no AI provider or API key. Status and location filters use Dossier's profile. Scores here are heuristic; explain that when discussing fit.",
    inputSchema: z.object({ startup_refresh_id: id.optional(), new_only: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(30), keywords: z.string().max(200).default(""), status: z.enum(["NEW", "SAVED", "CONTACTED", "DISMISSED"]).default("NEW"), place: z.enum(["any", "city", "country", "remote"]).default("any"), use_preferences: z.boolean().default(true) }),
    annotations: { readOnlyHint: false },
  }, async (input) => {
    let refreshResult: unknown = null;
    if (input.startup_refresh_id) {
      const job = await getJob(input.startup_refresh_id);
      if (!job || job.type !== "startups-refresh") return failure("That startup refresh doesn't exist. Start one with find_opportunities.");
      if (job.status === "FAILED") return failure(job.error ?? "The startup refresh failed. Try again.");
      if (job.status !== "DONE") return text({ status: "working", step: job.step, startup_refresh_id: job.id, next: "Call list_startups again in a few seconds with this startup_refresh_id." });
      refreshResult = job.result;
    }
    const profile = await loadProfile();
    const filter = startupFilterSchema.parse({ q: input.keywords, status: input.status, place: input.place });
    const all = await listStartups(filter, placeOf(profile.basics), { limit: 5_000 });
    const preferences = input.use_preferences ? await loadSearchPreferences() : null;
    const matching = preferences ? all.startups.filter((startup) => startupMatchesPreferences(startup, preferences)) : all.startups;
    const selected = await unseenItems("startups", matching, (startup) => [`startup:${startup.id}`], input.limit, input.new_only);
    return text({ status: "done", refresh: refreshResult, search_preferences: preferences, total_matching: matching.length, remaining: selected.remaining, startups: selected.items.map((startup) => ({ startup_id: startup.id, source: startup.source, company: startup.company, summary: startup.summary, location: startup.location, remote: startup.remote, roles: startup.roles, score: startup.score, reasons: startup.reasons, status: startup.status, application_id: startup.applicationId, website: startup.website, links: startup.links, link: `${origin}/startups` })), link: `${origin}/startups` });
  });

  server.registerTool("get_startup", {
    title: "Read a startup's hiring post",
    description: "Read a startup's full hiring text and matching reasons. Use startup_id with get_posting and save_application to draft and link an application. Private notes and contact addresses are omitted.",
    inputSchema: z.object({ startup_id: id }), annotations: { readOnlyHint: true },
  }, async ({ startup_id }) => {
    const startup = await getStartup(startup_id);
    return startup ? text({ startup_id, company: startup.company, posting: startupPostingText(startup), source: startup.source, website: startup.website, links: startup.links, score: startup.score, reasons: startup.reasons, application_id: startup.applicationId, status: startup.status, link: `${origin}/startups` }) : failure("That startup no longer exists.");
  });

  server.registerTool("set_startup_status", {
    title: "Save or update a startup opportunity",
    description: "Save a startup, dismiss it, or record that the user contacted it. Only records the user's choice; never sends anything. NEW puts it back in the new list.",
    inputSchema: z.object({ startup_id: id, status: z.enum(["NEW", "SAVED", "CONTACTED", "DISMISSED"]) }), annotations: { readOnlyHint: false, idempotentHint: true },
  }, async ({ startup_id, status }) => {
    const startup = await updateStartup(startup_id, { status });
    return startup ? text({ startup_id, status: startup.status, link: `${origin}/startups` }) : failure("That startup no longer exists.");
  });
}
