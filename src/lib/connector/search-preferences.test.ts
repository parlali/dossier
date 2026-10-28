import { describe, expect, it } from "vitest";

import { EMPTY_QUERY } from "@/lib/job-search/search";
import { searchPreferencesSchema, searchTargets, startupMatchesPreferences } from "./search-preferences";

const preferences = searchPreferencesSchema.parse({ on_site_countries: ["gb", "ae"], remote_regions: ["Europe", "MENA"] });

describe("saved UK/UAE on-site and Europe/MENA remote preferences", () => {
  it("uses four bounded country queries per run without altering the profile's residence", () => {
    const targets = searchTargets(preferences, { ...EMPTY_QUERY, keywords: "designer", country: "de", place: "Berlin" }, 0);
    expect(targets.map(({ mode, query }) => [mode, query.country, query.remoteOnly, query.workMode, query.place])).toEqual([
      ["onsite", "gb", false, "onsite", ""], ["onsite", "ae", false, "onsite", ""],
      ["remote", "gb", true, "remote", ""], ["remote", "ae", true, "remote", ""],
    ]);
    expect(targets.every(({ query }) => query.keywords === "designer")).toBe(true);
  });

  it("rotates remote country indexes and preserves both on-site searches", () => {
    const targets = searchTargets(preferences, EMPTY_QUERY, 1);
    expect(targets.map(({ query }) => query.country)).toEqual(["gb", "ae", "de", "sa"]);
    expect(targets[2].label).toContain("Europe remote");
    expect(targets[3].label).toContain("MENA remote");
  });

  it("keeps relevant startup locations while excluding known incompatible remote restrictions", () => {
    const startup = (location: string) => ({ source: "HN" as const, location, summary: "Designer", details: `Example | ${location}\nHiring a designer` });
    expect(startupMatchesPreferences(startup("London, UK | onsite"), preferences)).toBe(true);
    expect(startupMatchesPreferences(startup("Dubai, UAE | onsite"), preferences)).toBe(true);
    expect(startupMatchesPreferences(startup("Remote Europe"), preferences)).toBe(true);
    expect(startupMatchesPreferences(startup("Remote GCC"), preferences)).toBe(true);
    expect(startupMatchesPreferences(startup("Remote worldwide"), preferences)).toBe(true);
    expect(startupMatchesPreferences(startup("Remote, US only"), preferences)).toBe(false);
    expect(startupMatchesPreferences(startup("New York, US | onsite"), preferences)).toBe(false);
    expect(startupMatchesPreferences(startup("UK | Remote"), { on_site_countries: ["gb"], remote_regions: [] })).toBe(false);
  });
});
