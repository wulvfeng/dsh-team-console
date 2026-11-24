#!/usr/bin/env node
/**
 * test/regression.mjs — 针对已修复缺陷的后端/协议/渲染回归测试
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { readArchivedSessionIds, isArchivedSession } from "../lib/archive.js";
import { readSessionEvents, readSessionHeader, readSessionSummary } from "../lib/sessions.js";
import { activityOf, buildTeamIndex, buildTeamIndexAsync, buildTeamModel, buildTreeTeamModel, sessionTranscript } from "../lib/team.js";
import { startTeamConsole } from "../lib/server.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dtc-reg-"));
let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log("  PASS: " + name);
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

  // 4. activityOf clears pending tools on turn/end + tracks PTC dispatch
  await test("activityOf: turn/end 清理未关闭工具并支持 PTC 子调用", () => {
    const activePtc = activityOf([
      { type: "turn/start", seq: 1, time: 10 },
      { type: "tool/call", seq: 2, time: 11, data: { callId: "c1", name: "run_code" } },
      { type: "tool/ptc-dispatch-start", seq: 3, time: 12, data: { subCallId: "c1:ptc:1", name: "pwsh" } }
    ]);
    assert.equal(activePtc.kind, "tool");
    assert.equal(activePtc.label, "正在调用 run_code · pwsh");

    const afterTurnEnd = activityOf([
      { type: "turn/start", seq: 1, time: 10 },
      { type: "tool/call", seq: 2, time: 11, data: { callId: "c1", name: "run_code" } },
      { type: "turn/end", seq: 3, time: 15 }
    ]);
    assert.equal(afterTurnEnd.kind, "idle");
    assert.equal(afterTurnEnd.openTools, 0);
  });

  // 5. HTTP server IPv6 Host header & security checks
  await test("server: 允许 IPv6 [::1] Host 头并拒绝非回环 Host", async () => {
    const srv = startTeamConsole({ port: 4480, sessionsRoot: tmpRoot, portAttempts: 5 });
    await srv.ready;
    const req = (headers) => new Promise((resolve, reject) => {
      const r = http.get({ host: "127.0.0.1", port: srv.port, path: "/api/health", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      r.on("error", reject);
    });
    try {
      assert.equal(await req({ Host: "[::1]:" + srv.port }), 200);
      assert.equal(await req({ Host: "evil.example.com" }), 403);
    } finally {
      srv.close();
    }
  });

  console.log("\n回归测试全部通过（" + passed + " 项）");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
