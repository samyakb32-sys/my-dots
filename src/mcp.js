// Minimal MCP client (Streamable HTTP, JSON-RPC). Any remote MCP server can supply tools this way:
// GitHub, Zapier (Gmail, Google Calendar, Slack, Notion, ...), Linear, ...
//
// MCP_SERVERS secret, JSON: [{"name":"github","url":"https://...","headers":{"Authorization":"Bearer ..."},"include":["tool_a"]}]
// Tools that don't declare readOnlyHint are treated as risky: the user must approve each call (see approvals.js).

const PROTOCOL = "2025-06-18";
const TOOLS_TTL = 60 * 60; // cache tool lists for an hour: listing costs 3 round-trips per server
const MAX_TOOLS_PER_SERVER = 30; // small free models degrade with huge tool lists
const RESULT_CHARS = 6000;

export function parseServers(env) {
  if (!env.MCP_SERVERS) return [];
  try {
    const list = JSON.parse(env.MCP_SERVERS);
    return (Array.isArray(list) ? list : [])
      .filter((s) => s?.name && /^https:\/\//.test(s.url ?? ""))
      .map((s) => ({ ...s, id: String(s.name).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "mcp" }))
      .slice(0, 5);
  } catch {
    console.error("MCP_SERVERS is not valid JSON");
    return [];
  }
}

function parseSse(text, id) {
  for (const block of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    try {
      const message = JSON.parse(data);
      if (message.id === id) return message;
    } catch {
      /* not a JSON event */
    }
  }
  throw new Error("no response in event stream");
}

async function post(server, body, session) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(server.headers || {}),
      ...(session.id ? { "mcp-session-id": session.id, "mcp-protocol-version": PROTOCOL } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${server.name}: HTTP ${res.status}`);
  session.id = res.headers.get("mcp-session-id") || session.id;
  if (body.id === undefined) return null; // notification: nothing to read
  const text = await res.text();
  const reply = (res.headers.get("content-type") || "").includes("text/event-stream") ? parseSse(text, body.id) : JSON.parse(text);
  if (reply.error) throw new Error(`${server.name}: ${reply.error.message}`);
  return reply.result;
}

async function connect(server) {
  const session = {};
  await post(
    server,
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "telegram-ai-bot", version: "1.0.0" } },
    },
    session,
  );
  await post(server, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
  return session;
}

async function listTools(env, server) {
  const cacheKey = `mcp:${server.id}`;
  const cached = await env.CHAT?.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const session = await connect(server);
  const tools = [];
  let cursor;
  for (let page = 0; page < 3; page++) {
    const result = await post(server, { jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} }, session);
    tools.push(...(result.tools || []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  const slim = tools
    .filter((t) => !server.include || server.include.includes(t.name))
    .slice(0, MAX_TOOLS_PER_SERVER)
    .map((t) => ({
      name: t.name,
      description: t.description || t.title || t.name,
      inputSchema: t.inputSchema,
      readOnly: t.annotations?.readOnlyHint === true,
    }));
  await env.CHAT?.put(cacheKey, JSON.stringify(slim), { expirationTtl: TOOLS_TTL });
  return slim;
}

async function callTool(server, name, args) {
  const session = await connect(server);
  const result = await post(server, { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: args } }, session);
  const text = (result.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return `${result.isError ? "Error: " : ""}${text}`.slice(0, RESULT_CHARS) || "(empty result)";
}

const cleanSchema = ({ $schema, ...schema } = {}) => ({ type: "object", properties: {}, ...schema });

/** Tools from every configured server, as [name, tool] entries shaped like the built-in TOOLS. */
export async function loadMcpTools(env) {
  const entries = [];
  await Promise.all(
    parseServers(env).map(async (server) => {
      try {
        for (const t of await listTools(env, server)) {
          entries.push([
            `${server.id}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
            {
              readOnly: t.readOnly,
              risky: !t.readOnly,
              description: `[${server.name}] ${t.description}`.slice(0, 600),
              parameters: cleanSchema(t.inputSchema),
              run: (_env, _ctx, args) => callTool(server, t.name, args),
            },
          ]);
        }
      } catch (e) {
        console.warn(`MCP server ${server.name} unavailable: ${e.message}`);
      }
    }),
  );
  return entries.sort((a, b) => (a[0] < b[0] ? -1 : 1)); // stable order whatever finished first
}

export const refreshMcp = (env) => Promise.all(parseServers(env).map((s) => env.CHAT?.delete(`mcp:${s.id}`)));
