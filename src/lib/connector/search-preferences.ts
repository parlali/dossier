import "server-only";

import { z } from "zod";

import type { SearchQuery } from "@/lib/job-search/search";
import { prisma } from "@/lib/prisma";
import { placeOf, reach } from "@/lib/startups/place";
import { whereText } from "@/lib/startups/match";
import type { StartupView } from "@/lib/startups/types";

export const SEARCH_PREFERENCES_KEY = "connectorSearchPreferences";
const PAGE_KEY = "connectorSearchLocationPage";

// These are search-index country pools, not assertions about a candidate's
// residence, work authorization, or an employer's remote-work eligibility.
export const REMOTE_COUNTRY_POOLS = {
  Europe: ["gb", "de", "fr", "nl", "ie", "es", "pt", "it", "se", "ch", "pl", "dk", "no", "fi", "be", "at", "cz", "ro", "gr"],
  MENA: ["ae", "sa", "eg", "qa", "jo", "ma", "om", "bh", "kw", "tn", "dz", "lb"],
} as const;

export const searchPreferencesSchema = z.object({
  on_site_countries: z.array(z.string().regex(/^[a-z]{2}$/)).max(4).default([]),
  remote_regions: z.array(z.enum(["Europe", "MENA"])).max(2).default([]),
});
export type SearchPreferences = z.output<typeof searchPreferencesSchema>;
export type SearchTarget = { label: string; mode: "onsite" | "remote" | "any"; query: SearchQuery };

export async function loadSearchPreferences(): Promise<SearchPreferences | null> {
  const row = await prisma.setting.findUnique({ where: { key: SEARCH_PREFERENCES_KEY } });
  if (!row) return null;
  try { const parsed = searchPreferencesSchema.safeParse(JSON.parse(row.value)); return parsed.success ? parsed.data : null; }
  catch { return null; }
}

export async function saveSearchPreferences(input: SearchPreferences): Promise<void> {
  const value = JSON.stringify(searchPreferencesSchema.parse(input));
  await prisma.setting.upsert({ where: { key: SEARCH_PREFERENCES_KEY }, create: { key: SEARCH_PREFERENCES_KEY, value }, update: { value } });
}

export async function locationPage(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: PAGE_KEY } });
  const value = Number(row?.value ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function advanceLocationPage(page: number): Promise<void> {
  await prisma.setting.upsert({ where: { key: PAGE_KEY }, create: { key: PAGE_KEY, value: String(page + 1) }, update: { value: String(page + 1) } });
}

/** Two on-site countries plus one rotating index country per remote region. */
export function searchTargets(preferences: SearchPreferences, base: SearchQuery, page: number): SearchTarget[] {
  return [
    ...[...new Set(preferences.on_site_countries)].map((country): SearchTarget => ({ label: `${country.toUpperCase()} on-site`, mode: "onsite", query: { ...base, country, place: "", remoteOnly: false, workMode: "onsite" } })),
    ...[...new Set(preferences.remote_regions)].map((region): SearchTarget => {
      const pool = REMOTE_COUNTRY_POOLS[region];
      const country = pool[page % pool.length];
      return { label: `${region} remote, ${country.toUpperCase()} index`, mode: "remote", query: { ...base, country, place: "", remoteOnly: true, workMode: "remote" } };
    }),
  ];
}

/** Unknown remote eligibility remains a candidate for Claude to check from the full posting. */
export function startupMatchesPreferences(startup: Pick<StartupView, "source" | "location" | "summary" | "details">, preferences: SearchPreferences): boolean {
  const text = whereText(startup);
  if (preferences.on_site_countries.some((country) => { const found = reach(text, placeOf({ city: "", country })); return found.here !== null && (!found.remote || /\b(on[- ]?site|hybrid|in[- ]office|office[- ]based)\b/i.test(text)); })) return true;
  return preferences.remote_regions.some((region) => REMOTE_COUNTRY_POOLS[region].some((country) => { const found = reach(text, placeOf({ city: "", country })); return found.remote && found.remoteOpen !== false; }));
}
