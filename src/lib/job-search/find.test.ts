import { describe, expect, it, vi } from "vitest";

import type { FoundPosting } from "./search";
import { EMPTY_QUERY } from "./search";

vi.mock("./config", () => ({ loadJobSearchConfig: async () => ({ source: "JSEARCH" }), credentialsFor: () => ({ key: "test", host: "openwebninja" }), requestContext: () => ({}) }));
vi.mock("./index", () => ({ searchPostings: async () => ({ postings: [true, false, null].map((remote) => ({ remote } as FoundPosting)), next: "cursor:next" }) }));

import { askSource } from "./find";

describe("work-mode filtering for source searches and saved-search pagination", () => {
  it("excludes confirmed remote jobs from on-site results", async () => {
    const result = await askSource({ ...EMPTY_QUERY, country: "gb", workMode: "onsite" });
    expect(result.ok && result.postings.map((posting) => posting.remote)).toEqual([false, null]);
    expect(result.ok && result.next).toBe("cursor:next");
  });
  it("excludes confirmed non-remote jobs from remote results", async () => {
    const result = await askSource({ ...EMPTY_QUERY, country: "ae", workMode: "remote", remoteOnly: true });
    expect(result.ok && result.postings.map((posting) => posting.remote)).toEqual([true, null]);
  });
  it("keeps the original mixed-mode behavior without a preference", async () => {
    const result = await askSource({ ...EMPTY_QUERY, country: "gb" });
    expect(result.ok && result.postings).toHaveLength(3);
  });
});
