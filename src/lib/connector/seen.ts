import "server-only";

import { prisma } from "@/lib/prisma";

/** Mark only returned items as seen, so response limits never hide unseen results forever. */
export async function unseenItems<T>(kind: "jobs" | "startups", items: T[], identities: (item: T) => string[], limit: number, newOnly: boolean): Promise<{ items: T[]; remaining: number }> {
  return prisma.$transaction(async (tx) => {
    const key = `connector-seen-${kind}`;
    await tx.setting.upsert({ where: { key }, create: { key, value: "[]" }, update: {} });
    const [row] = await tx.$queryRaw<{ value: string }[]>`SELECT value FROM "Setting" WHERE key = ${key} FOR UPDATE`;
    let previous: unknown;
    try { previous = JSON.parse(row.value); } catch { previous = []; }
    const history = new Set(Array.isArray(previous) ? previous.filter((value): value is string => typeof value === "string") : []);
    const batch = new Set<string>();
    const fresh = items.filter((item) => {
      const keys = identities(item);
      if (keys.some((id) => batch.has(id)) || (newOnly && keys.some((id) => history.has(id)))) return false;
      keys.forEach((id) => batch.add(id));
      return true;
    });
    const returned = fresh.slice(0, limit);
    for (const item of returned) for (const id of identities(item)) { history.delete(id); history.add(id); }
    await tx.setting.update({ where: { key }, data: { value: JSON.stringify([...history].slice(-10_000)) } });
    return { items: returned, remaining: Math.max(0, fresh.length - returned.length) };
  });
}
