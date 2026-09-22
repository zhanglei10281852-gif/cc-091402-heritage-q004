import { createServer } from "node:http";
import { WorkCalendar } from "./calendar.js";
import { loadReference, resolveDataFile } from "./config.js";
import { JsonStore } from "./store.js";
import { LoanService, ServiceError } from "./service.js";

export function createContainer(options = {}) {
  const reference = options.reference ?? loadReference();
  const calendar = options.calendar ?? new WorkCalendar(reference.calendar);
  const store = options.store ?? new JsonStore(options.dataFile ?? resolveDataFile());
  const service = new LoanService({
    store,
    reference,
    calendar,
    now: options.now ?? (() => new Date()),
  });
  return { reference, calendar, store, service };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new ServiceError(413, "payload_too_large", "请求体超过 2MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ServiceError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

export function createApp(options = {}) {
  const { service, reference } = createContainer(options);

  // HTTP 头只能用 ASCII：经办角色使用键名，中文业务角色通过别名映射
  const roleAliases = {
    applicant: "申请方",
    admin: "管理员",
    conservator: "保护人员",
    viewer: "只读访客",
  };

  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const actor = request.headers["x-user-id"]
      ? {
          id: String(request.headers["x-user-id"]),
          role: roleAliases[String(request.headers["x-user-role"] ?? "")]
            ?? String(request.headers["x-user-role"] ?? ""),
          name: String(request.headers["x-user-name"] ?? ""),
        }
      : null;

    try {
      if (request.method === "GET" && pathname === "/health") {
        send(response, 200, { status: "ok", service: "loan-approval-service" });
        return;
      }

      if (request.method === "GET" && pathname === "/reference") {
        send(response, 200, reference);
        return;
      }

      let match;
      if (request.method === "POST" && pathname === "/applications") {
        const body = await readJson(request);
        send(response, 201, await service.create(actor, body));
        return;
      }
      if (request.method === "GET" && pathname === "/applications") {
        send(response, 200, { applications: await service.list() });
        return;
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)$/))) {
        if (request.method === "GET") {
          send(response, 200, await service.getView(match[1]));
          return;
        }
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)\/versions$/))) {
        if (request.method === "POST") {
          const body = await readJson(request);
          send(response, 200, await service.submitVersion(actor, match[1], body));
          return;
        }
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)\/certificate$/))) {
        if (request.method === "POST") {
          const body = await readJson(request);
          send(response, 200, await service.replaceCertificate(actor, match[1], body));
          return;
        }
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)\/decisions\/([^/]+)$/))) {
        if (request.method === "POST") {
          const body = await readJson(request);
          send(response, 200, await service.decide(actor, match[1], match[2], body.decision, body.comment));
          return;
        }
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)\/escalations$/))) {
        if (request.method === "POST") {
          send(response, 200, await service.escalate(actor, match[1]));
          return;
        }
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)\/packing$/))) {
        if (request.method === "POST") {
          const body = await readJson(request);
          send(response, 200, await service.pack(actor, match[1], body.lines, body.complete === true));
          return;
        }
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)\/withdraw$/))) {
        if (request.method === "POST") {
          send(response, 200, await service.withdraw(actor, match[1]));
          return;
        }
      }
      if ((match = pathname.match(/^\/applications\/([^/]+)\/return$/))) {
        if (request.method === "POST") {
          send(response, 200, await service.markReturned(actor, match[1]));
          return;
        }
      }

      send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ServiceError) {
        send(response, error.status, { error: error.code, message: error.message, details: error.details });
        return;
      }
      send(response, 500, { error: "internal_error", message: error.message });
    }
  });
}
