import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JsonStore, MemoryStore } from "./store.js";
import { loadCalendar } from "./calendar.js";
import { ApprovalEngine } from "./engine.js";
import rolesRef from "../reference/approval-roles.json" with { type: "json" };
import calendarRef from "../reference/workday-calendar-2026.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));

export function createEngine(options = {}) {
  const store = options.store ?? new JsonStore(options.dataFile ?? resolve(HERE, "..", ".data", "approvals.json"));
  const calendar = options.calendar ?? loadCalendar(options.calendarData ?? calendarRef);
  return new ApprovalEngine({ store, calendar, clock: options.clock, roles: options.roles ?? rolesRef });
}

export function createApp(engine = createEngine()) {
  return createServer(async (request, response) => {
    await route(request, response, engine).catch((error) => sendError(response, error));
  });
}

async function route(request, response, engine) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/health") {
    return json(response, 200, { status: "ok", service: "loan-approval-service" });
  }

  const appMatch = pathname.match(/^\/applications\/([^/]+)(?:\/(versions|decisions|pack|unpack|withdraw))?$/);
  if (request.method === "POST" && pathname === "/applications") {
    const body = await readBody(request);
    const actor = actorOf(request, body);
    const result = engine.submitApplication({ input: body.input ?? body, actor });
    return json(response, 201, result);
  }
  if (request.method === "GET" && pathname === "/applications") {
    return json(response, 200, { applications: engine.listApplications().map(summary) });
  }
  if (appMatch) {
    const [, applicationId, action] = appMatch;
    if (request.method === "GET" && !action) {
      return json(response, 200, engine.explain(applicationId));
    }
    const body = await readBody(request);
    const actor = actorOf(request, body);
    if (request.method === "POST" && action === "versions") {
      const result = engine.submitApplication({ applicationId, input: body.input ?? body, actor });
      return json(response, 201, result);
    }
    if (request.method === "POST" && action === "decisions") {
      const result = engine.decide({
        applicationId,
        node: body.node,
        actor,
        action: body.decision ?? body.action,
        note: body.note ?? null,
        onBehalfOfEscalation: Boolean(body.onBehalfOfEscalation),
      });
      return json(response, 200, result);
    }
    if (request.method === "POST" && action === "pack") {
      return json(response, 200, engine.pack({ applicationId, actor, manifest: body.manifest }));
    }
    if (request.method === "POST" && action === "unpack") {
      return json(response, 200, engine.unpack({ applicationId, actor, reason: body.reason ?? null }));
    }
    if (request.method === "POST" && action === "withdraw") {
      return json(response, 200, engine.withdraw({ applicationId, actor, reason: body.reason ?? null }));
    }
  }
  if (request.method === "POST" && pathname === "/admin/sweep-escalations") {
    return json(response, 200, engine.sweepEscalations());
  }

  return json(response, 404, { error: "not_found" });
}

function actorOf(request, body) {
  const header = request.headers["x-actor-id"];
  const actor = header || body.actor;
  if (!actor) throw Object.assign(new Error("缺少身份字段 x-actor-id / actor"), { statusCode: 401, code: "unauthenticated" });
  return String(actor);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400, code: "invalid_json" });
  }
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  const status = error.statusCode ?? 500;
  json(response, status, {
    error: error.code ?? "internal_error",
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
  });
}

function summary(app) {
  return {
    id: app.id,
    status: app.status,
    currentVersionSeq: app.currentSeq,
    approvedSeq: app.approvedSeq,
    risk: app.risk?.level ?? null,
    applicantId: app.applicantId,
  };
}

export { MemoryStore };
