import type { CallToolResult } from "@modelcontextprotocol/server";

export const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export const failure = (message: string): CallToolResult => ({ ...text(message), isError: true });
