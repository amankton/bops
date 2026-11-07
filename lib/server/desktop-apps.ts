import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { UseWhere } from "./access-sync";
import { APP_TOOLS, composioOn, findAppActions, runAppAction } from "./composio";
import { loadDesktopComposio } from "./composio-desktop";
import { heldAsk } from "./permission";
import { bot } from "./store";

export type DesktopAppsMcp = { url: string; token: string };

/** One loopback MCP server per agent run. The client receives only a short-lived token for this bot. */
export async function startDesktopApps(botId: string, where: UseWhere, valid: () => boolean) {
  await loadDesktopComposio();
  const tools = () => {
    const current = bot(botId);
    return current && composioOn() && valid() ? APP_TOOLS(current) : [];
  };
  if (!tools().length) return;
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const http = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const port = req.socket.localPort;
    if (req.url !== "/mcp" || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !valid()) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = new Server({ name: "Bops Connected Apps", version: "1.0.0" }, { capabilities: { tools: {} } });
    res.once("close", () => { void server.close().catch(() => {}); });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools().map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      const alive = () => valid() && !signal.aborted && !res.destroyed;
      const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
      if (!alive() || !tools().some((tool) => tool.name === params.name)) return reply("This bot has no connected app tools for this run.", true);
      const args = params.arguments ?? {};
      try {
        if (params.name === "find_app_actions") {
          if (typeof args.query !== "string" || !args.query.trim()) return reply("Provide a query to find app actions.", true);
          const result = await findAppActions(botId, args.query, where);
          return alive() ? reply(result) : reply("This run was stopped.", true);
        }
        if (typeof args.action !== "string" || !args.action || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments) ||
            (args.account != null && typeof args.account !== "string")) return reply("Provide an action, its arguments, and an optional account name.", true);
        return reply(await runAppAction(botId, args.action, args.arguments as Record<string, unknown>, where, args.account as string | null | undefined, {
          valid: alive,
          approve: (ask) => heldAsk(ask, { botId, chatId: where.chatId, threadId: where.sessionId, routineId: where.via === "routine" ? where.viaId : undefined }, { ms: 9 * 60_000, alive }),
        }));
      } catch {
        return reply("The connected app call failed. Check the connection in Bops Logins.", true);
      }
    });
    void server.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") {
    http.close();
    throw new Error("Bops could not start its connected app tools.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close() {
      http.close();
      http.closeAllConnections();
    },
  };
}
