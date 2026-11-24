/**
 * dsh-team-console — 本地 Web 仪表盘（HTTP 服务）。
 *
 * 安全边界：
 *  - 只接受回环地址（127.0.0.1 / localhost / ::1），拒绝 0.0.0.0 等对外绑定；
 *  - 校验 Host 头，降低 DNS rebinding 风险；
 *  - 静态资源走白名单路由，不接受任意文件名；
 *  - sessionId 走白名单（字母数字 . _ -），拒绝路径穿越。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { defaultSessionsRoot, isSafeSessionId } from "./sessions.js";
import { buildTeamIndexAsync, buildTeamModel, buildTreeTeamModel, sessionTranscript } from "./team.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");
let PKG_VERSION = "0.0.0";
try {
  PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve(HERE, "..", "package.json"), "utf8")).version || PKG_VERSION;
} catch {
  /* 版本号读取失败不影响服务 */
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const STATIC_ROUTES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/** DSH Web GUI 与本服务同机不同端口，只读 GET 需要跨源许可；服务只监听回环，故放开 *。 */
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function hostHeaderAllowed(headerValue) {
  if (!headerValue) return true;
  const raw = String(headerValue).trim().toLowerCase();
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close === -1) return false;
    return LOOPBACK_HOSTS.has(raw.slice(0, close + 1));
  }
  const firstColon = raw.indexOf(":");
  const lastColon = raw.lastIndexOf(":");
  const hostOnly = firstColon !== -1 && firstColon === lastColon ? raw.slice(0, firstColon) : raw;
  return LOOPBACK_HOSTS.has(hostOnly) || LOOPBACK_HOSTS.has("[" + hostOnly + "]");
}

function sendJson(res, status, value, req) {
  const body = JSON.stringify(value);
  const request = req || (res && res.__req) || null;
  const accept = request && request.headers ? request.headers["accept-encoding"] : "";
  const acceptsGzip = typeof accept === "string" && accept.indexOf("gzip") !== -1;
  if (acceptsGzip && body.length > 4096) {
    const gzipped = zlib.gzipSync(Buffer.from(body, "utf8"));
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      ...corsHeaders(),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": gzipped.length,
    });
    res.end(gzipped);
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(),
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "content-type": contentType || "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(),
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function serveStatic(res, name) {
  const file = path.resolve(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, "forbidden");
  fs.readFile(file, (error, buffer) => {
    if (error) return sendText(res, 404, "not found");
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(buffer);
  });
}

/**
 * 启动仪表盘服务。
 * @param {{port?: number, host?: string, sessionsRoot?: string, maxAgeDays?: number, logger?: any, portAttempts?: number}} options
 * @returns {{port: number, url: string, ready: Promise<any>, close: Function}}
 */
export function startTeamConsole(options) {
  const opts = options || {};
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot();
  const host = opts.host || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("team-console 只允许绑定回环地址，收到：" + host);
  }
  const maxAgeDays = typeof opts.maxAgeDays === "number" ? opts.maxAgeDays : 14;
  const basePort = Number.isInteger(opts.port) ? opts.port : 4318;
  const attempts = Number.isInteger(opts.portAttempts) ? opts.portAttempts : 20;

  let disposed = false;
  let resolved = false;
  let resolveReady = null;
  let rejectReady = null;
  const servers = [];
  const state = { port: basePort, url: "" };

  const handler = (req, res) => {
    res.__req = req;
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (!hostHeaderAllowed(req.headers.host)) {
      return sendJson(res, 403, { error: "host not allowed" }, req);
    }
    let url;
    try {
      url = new URL(req.url || "/", "http://" + host);
    } catch {
      return sendJson(res, 400, { error: "bad url" }, req);
    }
    const pathname = url.pathname;
    try {
      if (STATIC_ROUTES[pathname]) return serveStatic(res, STATIC_ROUTES[pathname]);
      if (pathname === "/favicon.ico") return sendText(res, 204, "");
      if (pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, sessionsRoot, version: PKG_VERSION }, req);
      }
      if (pathname === "/api/teams") {
        const includeArchived = url.searchParams.get("includeArchived") === "1";
        buildTeamIndexAsync({ sessionsRoot, maxAgeDays, includeArchived, archiveFile: opts.archiveFile })
          .then((teams) => {
            sendJson(res, 200, { sessionsRoot, teams, generatedAt: Date.now() }, req);
          })
          .catch((error) => {
            sendJson(res, 500, { error: error && error.message ? error.message : String(error) }, req);
          });
        return;
      }
      if (pathname === "/api/team") {
        const leadId = url.searchParams.get("lead") || "";
        if (!isSafeSessionId(leadId)) return sendJson(res, 400, { error: "invalid lead id" }, req);
        const includeArchived = url.searchParams.get("includeArchived") === "1";
        let team = buildTeamModel({ sessionsRoot, leadId, archiveFile: opts.archiveFile });
        if (!team || !team.members || team.members.length === 0) {
          team = buildTreeTeamModel({ sessionsRoot, leadId, includeArchived, archiveFile: opts.archiveFile }) || team;
        }
        if (!team) return sendJson(res, 404, { error: "team not found", leadId }, req);
        return sendJson(res, 200, { team }, req);
      }
      if (pathname.indexOf("/api/session/") === 0) {
        let sessionId = "";
        try {
          sessionId = decodeURIComponent(pathname.slice("/api/session/".length));
        } catch {
          return sendJson(res, 400, { error: "bad session id" }, req);
        }
        if (!isSafeSessionId(sessionId)) return sendJson(res, 400, { error: "invalid session id" }, req);
        const rawLimit = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 200;
        const transcript = sessionTranscript({
          sessionsRoot,
          sessionId,
          limit: Math.max(1, Math.min(1000, limit)),
        });
        if (!transcript) return sendJson(res, 404, { error: "session not found", sessionId }, req);
        return sendJson(res, 200, { transcript }, req);
      }
      return sendJson(res, 404, { error: "not found", pathname }, req);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      try {
        opts.logger?.warn?.("[team-console] " + message);
      } catch {
        /* ignore */
      }
      return sendJson(res, 500, { error: message }, req);
    }
  };

  const tryListen = (port, remaining) => {
    if (disposed || resolved) return;
    const server = http.createServer(handler);
    servers.push(server);
    server.on("error", (error) => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (error && error.code === "EADDRINUSE" && remaining > 0 && !disposed && !resolved) {
        tryListen(port + 1, remaining - 1);
        return;
      }
      const message = error && error.message ? error.message : String(error);
      try {
        opts.logger?.error?.("[team-console] listen failed: " + message);
      } catch {
        /* ignore */
      }
      if (!resolved) {
        resolved = true;
        rejectReady(new Error("team-console 无法监听端口（起始 " + basePort + "）：" + message));
      }
    });
    server.listen(port, host, () => {
      if (disposed) {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        return;
      }
      state.port = port;
      state.url = "http://" + (host === "::1" ? "[::1]" : host) + ":" + port + "/";
      try {
        opts.logger?.info?.("[team-console] dashboard at " + state.url);
      } catch {
        /* ignore */
      }
      if (!resolved) {
        resolved = true;
        resolveReady(handle);
      }
    });
  };

  const handle = {
    get port() {
      return state.port;
    },
    get url() {
      return state.url;
    },
    get ready() {
      return ready;
    },
    close() {
      disposed = true;
      for (const server of servers) {
        try {
          server.close();
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
      }
    },
  };

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(new Error("team-console 启动超时：端口 " + basePort + " 起 20 个端口均不可用"));
    }, 8000).unref?.();
  });

  tryListen(basePort, attempts);
  return handle;
}