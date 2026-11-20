// Standalone server entry: Bun.serve with two jobs —
//   1. `POST /actions` — the action RPC endpoint. The browser posts
//      `{ action, args }` and gets `{ data }` back (or `{ error }`).
//      Request args are validated against the action's zod request
//      schema, the handler runs, and the result is validated against
//      its response schema — the same contract the Muse host enforced.
//   2. Static files — serves the built client from `client/dist/`
//      (run `bun run build` first); unknown paths fall back to
//      `index.html`.
// On boot it runs the drizzle migrations, creating an empty SQLite
// database at `DATABASE_PATH` when none exists yet.

import { join } from "node:path";
import { Actions } from "./actions";
import { createCtx, DATABASE_PATH, migrateDb } from "./db";
import type { ActionDef } from "./sdk";

const PORT = Number(process.env.PORT ?? 3000);
const CLIENT_DIST = join(import.meta.dir, "../../client/dist");

migrateDb();
console.log(`[nbn-plan-monitor] database: ${DATABASE_PATH}`);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleAction(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }
  const action = (body as { action?: unknown } | null)?.action;
  const args = (body as { args?: unknown } | null)?.args ?? {};
  if (typeof action !== "string") {
    return json({ error: "缺少 action 字段" }, 400);
  }
  const def = (Actions as Record<string, ActionDef<any, any>>)[action];
  if (!def || typeof def.handler !== "function") {
    return json({ error: `未知 action: ${action}` }, 404);
  }
  const parsed = def.request.safeParse(args);
  if (!parsed.success) {
    return json(
      {
        error: "请求参数不合法",
        issues: parsed.error.issues.map(
          (i: { path: PropertyKey[]; message: string }) => ({
            path: i.path.join("."),
            message: i.message,
          }),
        ),
      },
      400,
    );
  }
  try {
    const result = await def.handler(createCtx(), parsed.data);
    const checked = def.response.safeParse(result);
    if (!checked.success) {
      console.error(`[nbn-plan-monitor] action ${action} 返回数据不合法`, checked.error);
      return json({ error: "服务端返回数据不合法" }, 500);
    }
    return json({ data: checked.data });
  } catch (e) {
    console.error(`[nbn-plan-monitor] action ${action} 失败`, e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/actions") {
      if (req.method !== "POST") {
        return json({ error: "请用 POST 请求 /actions" }, 405);
      }
      return handleAction(req);
    }
    if (url.pathname === "/health") {
      return json({ ok: true });
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(CLIENT_DIST, path));
    if (await file.exists()) return new Response(file);
    // SPA fallback: any other path serves the app shell.
    const index = Bun.file(join(CLIENT_DIST, "index.html"));
    if (await index.exists()) return new Response(index);
    return new Response(
      "客户端尚未编译：请先运行 bun run build 再启动服务。",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
});

console.log(`[nbn-plan-monitor] listening on http://localhost:${PORT}`);
