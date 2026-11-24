#!/usr/bin/env node
/**
 * test/regression.mjs — 针对已修复缺陷的后端/协议/渲染回归测试
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { readArchivedSessionIds, isArchivedSession } from "../lib/archive.js";
import { readSessionEvents, readSessionHeader, readSessionSummary } from "../lib/sessions.js";
import { activityOf, buildTeamIndex, buildTeamIndexAsync, buildTeamModel, buildTreeTeamModel, sessionTranscript } from "../lib/team.js";
import { startTeamConsole } from "../lib/server.js";
import { apply } from "../lib/index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dtc-reg-"));
let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log("  PASS: " + name);
  });
}

/** 发一个 HTTP 请求，返回 {status, headers, body: Buffer}。 */
function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ host: "127.0.0.1", method: "GET" }, options), (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** 发原始 HTTP 报文（用于构造缺 Host / 空 Host 这类畸形请求）。 */
function rawHttp(port, requestLines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(requestLines.join("\r\n") + "\r\n\r\n");
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(5000, () => { socket.destroy(); resolve(data); });
  });
}

try {
  // 1. Plain JSONL incremental append + line without trailing newline
  await test("sessions: 纯文本 JSONL 增量追加不丢失历史且支持无末尾换行", () => {
    const f = path.join(tmpRoot, "plain.jsonl");
    const e0 = JSON.stringify({ type: "session", id: "s1", createdAt: 1 });
    const e1 = JSON.stringify({ type: "turn/start", seq: 1, time: 10, data: { turn: 1 } });
    fs.writeFileSync(f, e0 + "\n" + e1 + "\n", "utf8");
    assert.equal(readSessionEvents(f).length, 2);
    const e2 = JSON.stringify({ type: "user/message", seq: 2, time: 11, data: { content: [{ type: "text", text: "hi" }] } });
    fs.appendFileSync(f, e2, "utf8");
    const evs = readSessionEvents(f);
    assert.equal(evs.length, 3);
    assert.equal(evs[2].seq, 2);
  });

  // 2. Zstd multi-frame + torn tail recovery + header chunk
  await test("sessions: Zstd 多帧解码与末尾半帧恢复", () => {
    const f = path.join(tmpRoot, "zstd-torn.jsonl.zstd");
    const f1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", id: "sz", createdAt: 100 }) + "\n"));
    const f2 = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "turn/start", seq: 1, time: 101, data: { turn: 1 } }) + "\n"));
    // Write frame 1 + partial frame 2 (torn)
    const torn = f2.subarray(0, Math.max(5, Math.floor(f2.length / 2)));
    fs.writeFileSync(f, Buffer.concat([f1, torn]));
    const evs1 = readSessionEvents(f);
    assert.equal(evs1.length, 1);
    assert.equal(readSessionHeader(f).id, "sz");
    // Complete frame 2
    fs.writeFileSync(f, Buffer.concat([f1, f2]));
    const evs2 = readSessionEvents(f);
    assert.equal(evs2.length, 2);
    assert.equal(evs2[1].type, "turn/start");
  });

  // 3. Archive filtering + teamId fork isolation + deleted tasks + lead owner + natural task sort
  await test("team & archive: 归档过滤、Fork teamId 隔离、已删任务过滤、Lead 负责人与任务自然排序", async () => {
    const home = path.join(tmpRoot, "home");
    const sessionsRoot = path.join(home, "sessions");
    const wsDir = path.join(sessionsRoot, "--ws--");
    const storagesDir = path.join(home, "storages");
    fs.mkdirSync(storagesDir, { recursive: true });

    const writeLog = (dirName, lines) => {
      const dir = path.join(wsDir, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.v4.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    };

    const now = Date.now();
    // Lead 1 (active)
    writeLog("session-lead-1", [
      { type: "session", version: 4, id: "session-lead-1", createdAt: now - 5000, cwd: "C:/proj", isSeeded: false, delegationDepth: 0 },
      { type: "user/message", seq: 1, time: now - 4900, data: { content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }], source: { kind: "runtime-context" } } },
      { type: "user/message", seq: 2, time: now - 4800, data: { content: [{ type: "text", text: "实现功能 X" }], source: { kind: "user" } } },
      { type: "turn/start", seq: 3, time: now - 4700, data: { turn: 1 } },
      { type: "team/member", seq: 4, time: now - 4600, data: { version: 2, teamId: "session-lead-1", member: { id: "m-1", name: "worker", description: "写代码", provider: "spawn", context: "fresh", phase: "active" } } },
      { type: "team/task", seq: 5, time: now - 4500, data: { version: 2, teamId: "session-lead-1", task: { id: "task-2", revision: 1, subject: "T2", description: "d2", status: "in_progress", ownerId: "session-lead-1", blockedBy: [], writeScopes: [] } } },
      { type: "team/task", seq: 6, time: now - 4400, data: { version: 2, teamId: "session-lead-1", task: { id: "task-10", revision: 1, subject: "T10", description: "d10", status: "pending", blockedBy: ["task-2"], writeScopes: [] } } },
      { type: "team/task", seq: 7, time: now - 4300, data: { version: 2, teamId: "session-lead-1", task: { id: "task-99", revision: 1, subject: "T99", description: "d99", status: "deleted", blockedBy: [], writeScopes: [] } } },
      { type: "tool/ptc-dispatch", seq: 8, time: now - 4200, data: { rootCallId: "rc1", parentCallId: "rc1", subCallId: "rc1:ptc:1", name: "spawn_teammate", arguments: { name: "worker", description: "PTC委派", prompt: "请完成" } } }
    ]);

    // Lead 2 (archived)
    writeLog("session-lead-2", [
      { type: "session", version: 4, id: "session-lead-2", createdAt: now - 3000, cwd: "C:/proj", isSeeded: false, delegationDepth: 0 },
      { type: "team/member", seq: 1, time: now - 2900, data: { version: 2, teamId: "session-lead-2", member: { id: "m-2", name: "w2", description: "x", provider: "spawn", context: "fresh", phase: "active" } } }
    ]);

    // Forked session inheriting lead-1 team events (different teamId!)
    writeLog("session-fork-1", [
      { type: "session", version: 4, id: "session-fork-1", createdAt: now - 2000, cwd: "C:/proj", isSeeded: true, delegationDepth: 0 },
      { type: "team/member", seq: 1, time: now - 4600, data: { version: 2, teamId: "session-lead-1", member: { id: "m-1", name: "worker", description: "写代码", provider: "spawn", context: "fresh", phase: "active" } } }
    ]);

    fs.writeFileSync(path.join(storagesDir, "workspace.json"), JSON.stringify({ global: { archivedSessionIds: ["session-lead-2"] } }));

    assert.equal(isArchivedSession("session-lead-2", { sessionsRoot }), true);
    assert.equal(isArchivedSession("session-lead-1", { sessionsRoot }), false);

    const teams = await buildTeamIndexAsync({ sessionsRoot, maxAgeDays: 7 });
    assert.equal(teams.length, 1);
    assert.equal(teams[0].leadId, "session-lead-1");
    assert.equal(teams[0].title, "实现功能 X");
    assert.equal(teams[0].taskCount, 2);

    const allTeams = buildTeamIndex({ sessionsRoot, maxAgeDays: 7, includeArchived: true });
    assert.equal(allTeams.length, 2);

    const model = buildTeamModel({ sessionsRoot, leadId: "session-lead-1" });
    assert.equal(model.tasks.length, 2);
    assert.deepEqual(model.tasks.map((t) => t.id), ["task-2", "task-10"]);
    assert.equal(model.tasks[0].ownerName, "lead");
    assert.equal(model.tasks[1].blocked, true);
    assert.equal(model.members[0].assignment.description, "PTC委派");
  });

  // 4. activityOf clears pending tools on turn/end + tracks PTC dispatch + 10 分钟衰减
  await test("activityOf: turn/end 清理未关闭工具、支持 PTC 子调用、10 分钟无事件标记 stale", () => {
    const now = Date.now();
    const activePtc = activityOf([
      { type: "turn/start", seq: 1, time: now - 3000 },
      { type: "tool/call", seq: 2, time: now - 2000, data: { callId: "c1", name: "run_code" } },
      { type: "tool/ptc-dispatch-start", seq: 3, time: now - 1000, data: { subCallId: "c1:ptc:1", name: "pwsh" } }
    ]);
    assert.equal(activePtc.kind, "tool");
    assert.equal(activePtc.label, "正在调用 run_code · pwsh");
    assert.equal(activePtc.stale, false);

    const afterTurnEnd = activityOf([
      { type: "turn/start", seq: 1, time: now - 5000 },
      { type: "tool/call", seq: 2, time: now - 4000, data: { callId: "c1", name: "run_code" } },
      { type: "turn/end", seq: 3, time: now - 3000 }
    ]);
    assert.equal(afterTurnEnd.kind, "idle");
    assert.equal(afterTurnEnd.openTools, 0);

    const staleActivity = activityOf([
      { type: "turn/start", seq: 1, time: now - 11 * 60 * 1000 },
      { type: "tool/call", seq: 2, time: now - 11 * 60 * 1000 + 1000, data: { callId: "c1", name: "run_code" } }
    ]);
    assert.equal(staleActivity.stale, true);
    assert.equal(staleActivity.label, "正在调用 run_code（10 分钟无新事件）");
  });

  // 5. HTTP server：Host 严格校验、方法限制、CORS 只回显回环 Origin
  await test("server: Host 头严格校验/方法限制/CORS 只回显回环 Origin", async () => {
    const srv = startTeamConsole({ port: 4480, sessionsRoot: tmpRoot, portAttempts: 5 });
    await srv.ready;
    const get = (headers, method) => httpRequest({ port: srv.port, path: "/api/health", headers, method });
    try {
      assert.equal((await get({}, "GET")).status, 200);
      assert.equal((await get({ Host: "[::1]:" + srv.port })).status, 200);
      assert.equal((await get({ Host: "[0:0:0:0:0:0:0:1]:" + srv.port })).status, 200);
      assert.equal((await get({ Host: "evil.example.com" })).status, 403);
      assert.equal((await get({ Host: "127.0.0.1:9999evil" })).status, 403);

      const noHost = await rawHttp(srv.port, ["GET /api/health HTTP/1.0", "Connection: close"]);
      assert.match(noHost, /^HTTP\/1\.[01] 403/, "缺 Host 的请求应 403，实际：" + noHost.split("\r\n")[0]);
      const emptyHost = await rawHttp(srv.port, ["GET /api/health HTTP/1.0", "Host: ", "Connection: close"]);
      assert.match(emptyHost, /^HTTP\/1\.[01] 403/, "空 Host 应 403，实际：" + emptyHost.split("\r\n")[0]);

      const post = await get({}, "POST");
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, "GET, HEAD, OPTIONS");

      const evil = await get({ Origin: "https://evil.example" });
      assert.equal(evil.status, 200);
      assert.equal(evil.headers["access-control-allow-origin"], undefined);
      assert.equal(JSON.parse(evil.body.toString("utf8")).ok, true);

      const allowed = await get({ Origin: "http://127.0.0.1:59405" });
      assert.equal(allowed.headers["access-control-allow-origin"], "http://127.0.0.1:59405");
      assert.equal(allowed.headers.vary, "origin");

      const sameOrigin = await get({});
      assert.equal(sameOrigin.headers["access-control-allow-origin"], undefined);

      const preflightDenied = await get({ Origin: "https://evil.example" }, "OPTIONS");
      assert.equal(preflightDenied.status, 204);
      assert.equal(preflightDenied.headers["access-control-allow-origin"], undefined);

      const preflightAllowed = await get({ Origin: "http://localhost:59405" }, "OPTIONS");
      assert.equal(preflightAllowed.status, 204);
      assert.equal(preflightAllowed.headers["access-control-allow-origin"], "http://localhost:59405");
      assert.equal(preflightAllowed.headers["access-control-allow-methods"], "GET, HEAD, OPTIONS");
    } finally {
      srv.close();
    }
  });


  // 6. A2：端口归一化 —— 越界端口同步抛错、port:0 回写真实端口、apply 失败不抛
  await test("server: 非法端口同步报错、port:0 回写真实端口、apply 失败不抛", async () => {
    assert.throws(() => startTeamConsole({ port: 70000 }), (error) => {
      assert.ok(error && /70000/.test(error.message), "错误信息应含收到的端口值：" + (error && error.message));
      return true;
    });
    assert.throws(() => startTeamConsole({ port: -1 }), /-1/);

    const srv = startTeamConsole({ port: 0, sessionsRoot: tmpRoot });
    await srv.ready;
    try {
      assert.ok(srv.port > 0, "端口应为内核分配的实际端口");
      assert.equal(srv.url.indexOf(":0/"), -1, "url 不应保留 :0：" + srv.url);
      assert.equal(Number(new URL(srv.url).port), srv.port);
      const res = await httpRequest({ port: srv.port, path: "/api/health" });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body.toString("utf8")).ok, true);
    } finally {
      srv.close();
    }

    const warnings = [];
    const dispose = apply({ logger: { warn(message) { warnings.push(message); } } }, { port: 70000 });
    assert.equal(typeof dispose, "function");
    assert.equal(warnings.length, 1, "应只 warn 一行中文，实际：" + JSON.stringify(warnings));
    assert.ok(/70000/.test(warnings[0]), "warn 应包含收到的值：" + warnings[0]);
    dispose();
  });

  // 7. A3：maxAgeDays / sessionsRoot 归一化
  await test("team: maxAgeDays 非法值回退 14 天，sessionsRoot 非法在启动期报错", async () => {
    const root = path.join(tmpRoot, "a3-root");
    const ws = path.join(root, "ws");
    const writeLead = (dirName, id, mtime) => {
      const dir = path.join(ws, dirName);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "session.v4.jsonl");
      fs.writeFileSync(file, [
        JSON.stringify({ type: "session", version: 4, id, createdAt: mtime, cwd: "C:/p" }),
        JSON.stringify({ type: "team/member", seq: 1, time: mtime, data: { version: 2, teamId: id, member: { id: "m-1", name: "w", description: "x", phase: "active" } } })
      ].join("\n") + "\n");
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    };
    const oldTime = Date.now() - 30 * 86400000;
    const newTime = Date.now() - 1000;
    writeLead("session-old-lead", "session-old-lead", oldTime);
    writeLead("session-new-lead", "session-new-lead", newTime);

    for (const value of [NaN, Infinity, 0]) {
      const teams = await buildTeamIndexAsync({ sessionsRoot: root, maxAgeDays: value });
      assert.equal(teams.length, 1, "maxAgeDays=" + String(value) + " 应只返回今天的 lead");
      assert.equal(teams[0].leadId, "session-new-lead");
    }
    const syncTeams = buildTeamIndex({ sessionsRoot: root, maxAgeDays: NaN });
    assert.equal(syncTeams.length, 1);
    assert.equal(syncTeams[0].leadId, "session-new-lead");

    // 服务端同样归一化 maxAgeDays=NaN，否则 /api/teams 会静默返回空列表
    const srv = startTeamConsole({ port: 0, sessionsRoot: root, maxAgeDays: NaN });
    await srv.ready;
    try {
      const res = await httpRequest({ port: srv.port, path: "/api/teams" });
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body.toString("utf8"));
      assert.equal(data.teams.length, 1);
      assert.equal(data.teams[0].leadId, "session-new-lead");
    } finally {
      srv.close();
    }

    assert.throws(() => startTeamConsole({ port: 0, sessionsRoot: 123 }), /sessionsRoot/);
    assert.throws(() => startTeamConsole({ port: 0, sessionsRoot: path.join(tmpRoot, "a3-missing-dir") }), /不存在/);
  });

  // 8. A5：缓存源字节预算生效（超过 12MB 后淘汰最旧文件）
  await test("sessions: 源字节预算超限后淘汰旧缓存（不会无限增长）", () => {
    const root = path.join(tmpRoot, "cache-budget");
    fs.mkdirSync(root, { recursive: true });
    const one = JSON.stringify({ type: "assistant/message", seq: 1, time: 1, data: { message: { content: [{ type: "text", text: "x".repeat(900) }] } } }) + "\n";
    const lines = Math.ceil((3 * 1024 * 1024) / one.length);
    const payload = one.repeat(lines);
    const files = [];
    for (let i = 0; i < 6; i += 1) {
      const file = path.join(root, "big-" + i + ".jsonl");
      fs.writeFileSync(file, payload, "utf8");
      files.push(file);
    }
    assert.ok(fs.statSync(files[0]).size >= 3 * 1024 * 1024);

    const originalReadFileSync = fs.readFileSync;
    const originalReadSync = fs.readSync;
    let readBytes = 0;
    fs.readFileSync = function (...args) {
      const out = originalReadFileSync.apply(fs, args);
      if (out && typeof out.length === "number") readBytes += out.length;
      return out;
    };
    fs.readSync = function (...args) {
      const n = originalReadSync.apply(fs, args);
      if (typeof n === "number") readBytes += n;
      return n;
    };
    try {
      for (const file of files) assert.ok(readSessionEvents(file).length > 0);
      readBytes = 0;
      assert.ok(readSessionEvents(files[0]).length > 0);
      assert.ok(readBytes > 1024 * 1024, "预算超限后最早的 3MB 文件应被重新读取，实际读取 " + readBytes + " 字节");
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.readSync = originalReadSync;
    }
  });

  // 9. A6：增量更新只读新增字节（纯文本 + zstd 各一条）
  await test("sessions: 增量更新只读取新增区间（纯文本与 zstd 都不整文件读）", () => {
    const originalReadFileSync = fs.readFileSync;
    const originalReadSync = fs.readSync;
    let readBytes = 0;
    fs.readFileSync = function (...args) {
      const out = originalReadFileSync.apply(fs, args);
      if (out && typeof out.length === "number") readBytes += out.length;
      return out;
    };
    fs.readSync = function (...args) {
      const n = originalReadSync.apply(fs, args);
      if (typeof n === "number") readBytes += n;
      return n;
    };
    try {
      const line = JSON.stringify({ type: "assistant/message", seq: 1, time: 1, data: { message: { content: [{ type: "text", text: "y".repeat(200) }] } } }) + "\n";
      const plainFile = path.join(tmpRoot, "inc-plain.jsonl");
      fs.writeFileSync(plainFile, line.repeat(Math.ceil((512 * 1024) / line.length)), "utf8");
      const plainFirst = readSessionEvents(plainFile);
      assert.ok(plainFirst.length > 1000);
      readBytes = 0;
      fs.appendFileSync(plainFile, JSON.stringify({ type: "user/message", seq: 2, time: 2, data: { content: [{ type: "text", text: "append" }] } }) + "\n", "utf8");
      const plainSecond = readSessionEvents(plainFile);
      assert.equal(plainSecond.length, plainFirst.length + 1);
      assert.ok(readBytes < 64 * 1024, "纯文本增量应只读新增字节，实际读 " + readBytes);

      const zFile = path.join(tmpRoot, "inc-zstd.jsonl.zstd");
      const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, "utf8"));
      const bigText = line.repeat(1000);
      fs.writeFileSync(zFile, Buffer.concat([frame(bigText), frame(bigText)]));
      const zFirst = readSessionEvents(zFile);
      assert.equal(zFirst.length, 2000);
      readBytes = 0;
      fs.appendFileSync(zFile, frame(JSON.stringify({ type: "turn/start", seq: 3, time: 3, data: { turn: 2 } }) + "\n"));
      const zSecond = readSessionEvents(zFile);
      assert.equal(zSecond.length, zFirst.length + 1);
      assert.ok(readBytes < 64 * 1024, "zstd 增量应只读新增区间，实际读 " + readBytes);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.readSync = originalReadSync;
    }
  });

  // 10. A7：10 分钟无事件 → stale:true / 带后缀 / phase 变 inactive；刚发生的仍 active
  await test("team: 长时间无事件的成员标记 stale 且 session-tree phase 变 inactive", () => {
    const root = path.join(tmpRoot, "stale-root");
    const ws = path.join(root, "ws");
    const now = Date.now();
    const write = (dirName, lines) => {
      const dir = path.join(ws, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.v4.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    };
    write("session-stale-lead", [
      { type: "session", version: 4, id: "session-stale-lead", createdAt: now - 900000, cwd: "C:/p" },
      { type: "user/message", seq: 1, time: now - 880000, data: { content: [{ type: "text", text: "跑一下" }], source: { kind: "user" } } }
    ]);
    write("stale-child-old", [
      { type: "session", version: 4, id: "stale-child-old", parentSession: "session-stale-lead", origin: "subagent", createdAt: now - 870000, cwd: "C:/p" },
      { type: "turn/start", seq: 1, time: now - 800000, data: { turn: 1 } },
      { type: "tool/call", seq: 2, time: now - 795000, data: { callId: "c1", name: "run_code" } }
    ]);
    write("stale-child-fresh", [
      { type: "session", version: 4, id: "stale-child-fresh", parentSession: "session-stale-lead", origin: "subagent", createdAt: now - 5000, cwd: "C:/p" },
      { type: "turn/start", seq: 1, time: now - 3000, data: { turn: 1 } },
      { type: "tool/call", seq: 2, time: now - 2000, data: { callId: "c2", name: "run_code" } }
    ]);
    const model = buildTreeTeamModel({ sessionsRoot: root, leadId: "session-stale-lead" });
    assert.ok(model && model.members.length === 2, "应还原出两个成员");
    const byId = new Map(model.members.map((m) => [m.id, m]));
    const oldMember = byId.get("stale-child-old");
    const freshMember = byId.get("stale-child-fresh");
    assert.equal(oldMember.activity.stale, true);
    assert.equal(oldMember.activity.label, "正在调用 run_code（10 分钟无新事件）");
    assert.equal(oldMember.phase, "inactive");
    assert.equal(freshMember.activity.stale, false);
    assert.equal(freshMember.phase, "active");
  });

  // 11. A8：依赖已删除任务不再永久阻塞
  await test("team: 依赖已删除任务的 pending 任务恢复 ready 且标注（已删除）", () => {
    const root = path.join(tmpRoot, "deleted-dep");
    const dir = path.join(root, "ws", "session-del-lead");
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(dir, "session.v4.jsonl"), [
      { type: "session", version: 4, id: "session-del-lead", createdAt: now - 1000, cwd: "C:/p" },
      { type: "team/member", seq: 1, time: now - 900, data: { version: 2, teamId: "session-del-lead", member: { id: "m-1", name: "worker", description: "x", phase: "active" } } },
      { type: "team/task", seq: 2, time: now - 800, data: { version: 2, teamId: "session-del-lead", task: { id: "task-1", subject: "旧任务", status: "deleted", blockedBy: [] } } },
      { type: "team/task", seq: 3, time: now - 700, data: { version: 2, teamId: "session-del-lead", task: { id: "task-2", subject: "后续", status: "pending", blockedBy: ["task-1"] } } }
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const model = buildTeamModel({ sessionsRoot: root, leadId: "session-del-lead" });
    assert.equal(model.tasks.length, 1);
    assert.equal(model.tasks[0].id, "task-2");
    assert.deepEqual(model.tasks[0].blockedBy, ["task-1"], "blockedBy 原始数组应保持");
    assert.equal(model.tasks[0].ready, true);
    assert.equal(model.tasks[0].blocked, false);
    assert.deepEqual(model.tasks[0].blockerLabels, ["task-1（已删除）"]);
  });

  // 12. A9（去重 + 404）+ A12（gzip;q=0 不压缩）
  await test("server: 重复 lead 去重、非团队会话 404、gzip;q=0 不压缩", async () => {
    const root = path.join(tmpRoot, "http-root");
    const writeSession = (wsName, dirName, lines) => {
      const dir = path.join(root, wsName, dirName);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "session.v4.jsonl");
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return file;
    };
    const now = Date.now();
    const leadLines = (id) => [
      { type: "session", version: 4, id, createdAt: now - 1000, cwd: "C:/p" },
      { type: "team/member", seq: 1, time: now - 900, data: { version: 2, teamId: id, member: { id: "m-1", name: "worker", description: "x", phase: "active" } } }
    ];
    const older = writeSession("ws-a", "session-dup-lead", leadLines("session-dup-lead"));
    const newer = writeSession("ws-b", "session-dup-lead", leadLines("session-dup-lead"));
    fs.utimesSync(older, new Date(now - 120000), new Date(now - 120000));
    fs.utimesSync(newer, new Date(now - 1000), new Date(now - 1000));
    writeSession("ws-a", "session-plain-http", [
      { type: "session", version: 4, id: "session-plain-http", createdAt: now - 5000, cwd: "C:/p" },
      { type: "user/message", seq: 1, time: now - 4000, data: { content: [{ type: "text", text: "普通会话" }], source: { kind: "user" } } }
    ]);
    writeSession("ws-a", "session-big-http", [
      { type: "session", version: 4, id: "session-big-http", createdAt: now - 5000, cwd: "C:/p" },
      { type: "user/message", seq: 1, time: now - 4000, data: { content: [{ type: "text", text: "长文本 " + "z".repeat(8000) }], source: { kind: "user" } } }
    ]);

    const srv = startTeamConsole({ port: 0, sessionsRoot: root });
    await srv.ready;
    try {
      const teamsRes = await httpRequest({ port: srv.port, path: "/api/teams" });
      assert.equal(teamsRes.status, 200);
      const teamsData = JSON.parse(teamsRes.body.toString("utf8"));
      assert.equal(teamsData.teams.length, 1, "同一 lead 出现在两个 workspace 只应有一条");
      assert.equal(teamsData.teams[0].leadId, "session-dup-lead");
      assert.ok(teamsData.teams[0].updatedAt > now - 60000, "应保留 updatedAt 最新的那条");

      const notTeam = await httpRequest({ port: srv.port, path: "/api/team?lead=session-plain-http" });
      assert.equal(notTeam.status, 404, "非团队会话不应返回 200 空模型");
      assert.equal(JSON.parse(notTeam.body.toString("utf8")).error, "team not found");

      const gz = await httpRequest({ port: srv.port, path: "/api/session/session-big-http", headers: { "accept-encoding": "gzip" } });
      assert.equal(gz.status, 200);
      assert.equal(gz.headers["content-encoding"], "gzip");
      assert.equal(JSON.parse(zlib.gunzipSync(gz.body).toString("utf8")).transcript.id, "session-big-http");

      const noGz = await httpRequest({ port: srv.port, path: "/api/session/session-big-http", headers: { "accept-encoding": "gzip;q=0" } });
      assert.equal(noGz.status, 200);
      assert.equal(noGz.headers["content-encoding"], undefined, "gzip;q=0 视为不接受压缩");
      assert.equal(JSON.parse(noGz.body.toString("utf8")).transcript.id, "session-big-http");
    } finally {
      srv.close();
    }
  });

  // 13. A10：sync / async 团队索引缓存互不污染
  await test("team: sync 先跑不污染 async 的 session-tree 兜底", async () => {
    const root = path.join(tmpRoot, "cache-split");
    const ws = path.join(root, "ws");
    const now = Date.now();
    const write = (dirName, lines) => {
      const dir = path.join(ws, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.v4.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    };
    write("session-tree-lead", [
      { type: "session", version: 4, id: "session-tree-lead", createdAt: now - 60000, cwd: "C:/p" },
      { type: "user/message", seq: 1, time: now - 50000, data: { content: [{ type: "text", text: "只靠会话树" }], source: { kind: "user" } } }
    ]);
    write("tree-child-1", [
      { type: "session", version: 4, id: "tree-child-1", parentSession: "session-tree-lead", origin: "subagent", createdAt: now - 40000, cwd: "C:/p" },
      { type: "turn/start", seq: 1, time: now - 30000, data: { turn: 1 } }
    ]);
    const syncTeams = buildTeamIndex({ sessionsRoot: root });
    assert.deepEqual(syncTeams, [], "同步索引没有会话树兜底");
    const asyncTeams = await buildTeamIndexAsync({ sessionsRoot: root });
    assert.equal(asyncTeams.length, 1, "异步索引应回退到会话树");
    assert.equal(asyncTeams[0].source, "session-tree");
  });

  // 14. 会话流发送者归属：成员会话的 user 消息属于 Lead/转达 Agent，后台任务是系统事件
  await test("sessionTranscript: 成员会话消息归属 Lead/转达 Agent，tool-jobs 归系统事件", () => {
    const root = path.join(tmpRoot, "sender-root");
    const ws = path.join(root, "ws");
    const now = Date.now();
    const write = (dirName, lines) => {
      const dir = path.join(ws, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.v4.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    };
    write("member-1", [
      { type: "session", version: 4, id: "member-1", parentSession: "session-lead-sender", origin: "subagent", delegationDepth: 1, createdAt: now - 5000, cwd: "C:/p" },
      { type: "user/message", seq: 1, time: now - 4900, data: { content: [{ type: "text", text: "TASK-FROM-LEAD" }], source: { kind: "user" } } },
      { type: "user/message", seq: 2, time: now - 4800, data: { content: [{ type: "text", text: "Agent worker-2 sent a message: HELLO-RELAY" }], source: { kind: "agent-message", form: "relay", senderSessionId: "member-2" } } },
      { type: "user/message", seq: 3, time: now - 4700, data: { content: [{ type: "text", text: "background job pwsh-1 finished [status: completed, exit code: 0]" }], source: { kind: "tool-jobs", form: "notice" } } },
      { type: "assistant/message", seq: 4, time: now - 4600, data: { message: { content: [{ type: "text", text: "DONE" }] } } }
    ]);
    write("session-lead-sender", [
      { type: "session", version: 4, id: "session-lead-sender", createdAt: now - 9000, cwd: "C:/p" },
      { type: "user/message", seq: 1, time: now - 8000, data: { content: [{ type: "text", text: "HUMAN-INPUT" }], source: { kind: "user" } } }
    ]);

    const member = sessionTranscript({ sessionsRoot: root, sessionId: "member-1" });
    assert.equal(member.kind, "member");
    const users = member.items.filter((it) => it.kind === "user");
    assert.equal(users.length, 2);
    assert.equal(users[0].text, "TASK-FROM-LEAD");
    assert.equal(users[0].sender.kind, "lead");
    assert.equal(users[0].sender.name, "Lead 主控");
    assert.equal(users[0].sender.relay, undefined, "任务书不是转达消息");
    assert.equal(users[1].text, "HELLO-RELAY", "转达前缀应被剥离");
    assert.equal(users[1].sender.kind, "agent");
    assert.equal(users[1].sender.name, "worker-2");
    assert.equal(users[1].sender.relay, true);
    const notices = member.items.filter((it) => it.kind === "team");
    assert.equal(notices.length, 1, "后台任务通知应渲染成系统事件");
    assert.equal(notices[0].text.indexOf("系统 ·"), 0);
    assert.ok(notices[0].text.indexOf("background job") !== -1);

    const lead = sessionTranscript({ sessionsRoot: root, sessionId: "session-lead-sender" });
    const leadUsers = lead.items.filter((it) => it.kind === "user");
    assert.equal(leadUsers.length, 1);
    assert.equal(leadUsers[0].sender.kind, "human");
    assert.equal(leadUsers[0].sender.name, "用户");
  });

  // 15. 团队列表成员数：没有 team/member 事件时用子会话兜底；有 team 事件时不重复计数
  await test("team index: 团队列表成员数与 session-tree 兜底一致且不重复计数", async () => {
    const now = Date.now();
    const mk = (root, wsName, dirName, lines) => {
      const dir = path.join(root, wsName, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.v4.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    };

    // A. 只有 team/task 事件（未开启团队协作）+ 2 个子会话：memberCount 必须按子会话兜底为 2
    const rootA = path.join(tmpRoot, "count-tree");
    mk(rootA, "ws", "session-count-lead", [
      { type: "session", version: 4, id: "session-count-lead", createdAt: now - 6000, cwd: "C:/p" },
      { type: "team/task", seq: 1, time: now - 5000, data: { version: 2, teamId: "session-count-lead", task: { id: "task-1", subject: "T", status: "in_progress", blockedBy: [] } } }
    ]);
    mk(rootA, "ws", "count-child-a", [
      { type: "session", version: 4, id: "count-child-a", parentSession: "session-count-lead", origin: "subagent", createdAt: now - 4500, cwd: "C:/p" },
      { type: "turn/start", seq: 1, time: now - 4000, data: { turn: 1 } }
    ]);
    mk(rootA, "ws", "count-child-b", [
      { type: "session", version: 4, id: "count-child-b", parentSession: "session-count-lead", origin: "subagent", createdAt: now - 4300, cwd: "C:/p" }
    ]);
    const teamsA = await buildTeamIndexAsync({ sessionsRoot: rootA });
    assert.equal(teamsA.length, 1);
    assert.equal(teamsA[0].memberCount, 2, "无 team/member 事件时应按子会话数兜底");
    assert.equal(teamsA[0].taskCount, 1);
    assert.equal(teamsA[0].openTaskCount, 1);

    // B. team/member 事件 + 同成员的子会话：不能把同一批成员算两遍
    const rootB = path.join(tmpRoot, "count-team");
    mk(rootB, "ws", "session-count-team-lead", [
      { type: "session", version: 4, id: "session-count-team-lead", createdAt: now - 6000, cwd: "C:/p" },
      { type: "team/member", seq: 1, time: now - 5000, data: { version: 2, teamId: "session-count-team-lead", member: { id: "m-1", name: "worker", phase: "active" } } }
    ]);
    mk(rootB, "ws", "count-child-m1", [
      { type: "session", version: 4, id: "count-child-m1", parentSession: "session-count-team-lead", origin: "subagent", createdAt: now - 4500, cwd: "C:/p" }
    ]);
    const teamsAsyncB = await buildTeamIndexAsync({ sessionsRoot: rootB });
    const teamsSyncB = buildTeamIndex({ sessionsRoot: rootB });
    for (const teams of [teamsAsyncB, teamsSyncB]) {
      assert.equal(teams.length, 1);
      assert.equal(teams[0].memberCount, 1, "team/member 事件优先，不应再叠加子会话");
    }
  });

  console.log("\n回归测试全部通过（" + passed + " 项）");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
