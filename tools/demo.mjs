#!/usr/bin/env node
/**
 * tools/demo.mjs — 示例团队演示（不碰真实会话）
 *
 * 在 demo/sessions 下生成一套"三成员协作"的会话日志（lead + 3 个 teammate），
 * 再用真实的数据层起一个只监听回环的控制台实例。
 *
 * 用法：node tools/demo.mjs [端口] [--open]
 *   默认端口 4320（避开插件占用的 4318）
 *   打开后地址形如 http://127.0.0.1:4320/?api=4320
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startTeamConsole } from "../lib/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEMO_ROOT = path.join(ROOT, "demo", "sessions");
const WORKSPACE = "demo-showcase";
const DEMO_CWD = "C:\\Users\\wulf4\\Desktop\\demo-site";
const MODEL = "DeepSeek-V4.1-Flash-1017";
const LEAD_ID = "session-demo-homepage";
const ARCHITECT = "demo-architect";
const BUILDER = "demo-builder";
const REVIEWER = "demo-reviewer";

/* ---------------------------------------------------------------- 事件工具 */

const say = (text) => ({ type: "text", text });
const think = (text) => ({ type: "reasoning", text });
const call = (id, name, args) => ({ type: "tool-call", id, name, arguments: JSON.stringify(args) });

function createSession(id, opts) {
  const lines = [];
  let seq = 0;
  const createdAt = opts.createdAt;
  lines.push(JSON.stringify({
    type: "session",
    seq: 0,
    time: createdAt,
    id,
    parentSession: opts.parentSession || null,
    cwd: opts.cwd || DEMO_CWD,
    createdAt,
    agentPreset: "default",
    origin: opts.origin || "user",
    delegationDepth: opts.depth || 0,
  }));
  const api = {
    id,
    lines,
    ev(type, data, time) {
      seq += 1;
      lines.push(JSON.stringify({ type, seq, time, data }));
      return seq;
    },
    title(text, time) {
      return api.ev("session/title", { title: text }, time);
    },
    turnStart(turn, time) {
      return api.ev("turn/start", { turn }, time);
    },
    turnEnd(time) {
      return api.ev("turn/end", {}, time);
    },
    user(text, time) {
      return api.ev("user/message", { content: [say(text)] }, time);
    },
    assistant(parts, time) {
      return api.ev("assistant/message", { message: { role: "assistant", content: parts, source: { model: MODEL } } }, time);
    },
    toolCall(callId, name, args, time) {
      return api.ev("tool/call", { callId, name, arguments: JSON.stringify(args) }, time);
    },
    toolResult(callId, text, time, isError) {
      return api.ev("tool/result", {
        toolCallId: callId,
        message: { role: "tool", toolCallId: callId, isError: isError === true, content: [say(text)] },
      }, time);
    },
  };
  return api;
}

function writeSession(session) {
  const dir = path.join(DEMO_ROOT, WORKSPACE, session.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.v4.jsonl"), session.lines.join("\n") + "\n", "utf8");
}

/* ---------------------------------------------------------------- 文案素材 */

const BRIEF_ARCHITECT = [
  "把 demo-site 首页的内容按「卖点 → 证据 → 报价」重排。",
  "",
  "要求：",
  "- 只改结构，不改文案措辞",
  "- 保留现有 12 个区块，允许合并同类项",
  "- 产出写到 src/content/home.new.md，文件头写一行 STATUS",
  "",
  "完成后用 send_message 把结论发回给 lead。",
].join("\n");

const BRIEF_BUILDER = [
  "按 src/content/home.new.md 的结构搭一版静态稿。",
  "",
  "- 先保证 pnpm build 能过，样式可以糙",
  "- 只复用现有 design token，不要引入新依赖",
  "- 组件路径按 src/components/<Name>.tsx",
].join("\n");

const BRIEF_REVIEWER = [
  "对 demo-site 首页做一轮视觉走查：对比度、信息层级、行动按钮是否唯一。",
  "",
  "结论按「问题 / 影响 / 建议」写，附文件位置。",
  "另外留意页脚是否缺法务信息（备案号、隐私政策、Cookie 说明）。",
].join("\n");

const FENCE = "\u0060\u0060\u0060";

const STRUCTURE_REPLY = [
  "## 首页内容结构（新版）",
  "",
  "1. **首屏** — 一句话卖点 + 主 CTA",
  "2. **证据 1** — 三家客户 logo 墙",
  "3. **证据 2** — 可用性数据（3 个指标）",
  "4. **报价** — 三档，默认高亮中间档",
  "",
  "旧版 12 个区块合并成 9 个，删掉重复卖点 3 处：",
  "",
  FENCE,
  "旧: 首屏卖点 / 第二屏卖点(重复) / 功能清单 / 客户 / 数据 / 报价 …",
  "新: 首屏卖点 / 客户 / 数据 / 功能(折叠) / 报价 / FAQ …",
  FENCE,
  "",
  "✓ 结构稿已写到 src/content/home.new.md（148 行）。",
].join("\n");

const REVIEW_REPLY = [
  "## 走查结论",
  "",
  "1. **主 CTA** — 白字落在 #6C7CFA 上只有 3.1:1，不达 AA；建议主色加深到 #4A5AE8（src/styles/button.css）",
  "2. **辅助文字** — 12px / #9AA3B2 长文吃力，建议提到 #5B6472（src/styles/typography.css）",
  "3. **页脚** — 缺备案号 / 隐私政策 / Cookie 说明，合规风险，建议三项一起补",
  "",
  "首屏行动按钮只有一个，层级没问题；卡片阴影和描边重复，建议只留描边。",
  "",
  "✓ 已把 CTA 和页脚两项标成高优先级。",
].join("\n");

/* ---------------------------------------------------------------- 生成数据 */

function buildDemo(now) {
  const MIN = 60000;
  const T0 = now - 44 * MIN;
  const at = (minutes, seconds) => T0 + Math.round(minutes * MIN + (seconds || 0) * 1000);

  /* ---------- Lead ---------- */
  const lead = createSession(LEAD_ID, { createdAt: T0, origin: "user" });
  lead.title("官网改版 · 三成员协作", at(0, 2));

  lead.turnStart(1, at(0, 5));
  lead.user([
    "帮我把官网首页重做一版：先让信息架构师把内容按「卖点 → 证据 → 报价」重排，页面工程师按新结构搭一版静态稿，最后让视觉评审走查对比度和信息层级。",
    "",
    "文案不用你们写，只动结构和样式。",
  ].join("\n"), at(0, 8));

  lead.assistant([
    say([
      "收到。我拆成三步走：",
      "",
      "1. **信息架构师** — 重排首页内容顺序，产出 src/content/home.new.md",
      "2. **页面工程师** — 按新结构搭静态稿，先保证能构建",
      "3. **视觉评审** — 对比度与层级走查",
      "",
      "三个人同时开工，任务板我一起建好。",
    ].join("\n")),
    call("call_spawn_1", "spawn_teammate", {
      name: "信息架构师",
      description: "首页内容结构重排",
      context: "fresh",
      mode: "continuable",
      prompt: BRIEF_ARCHITECT,
    }),
    call("call_spawn_2", "spawn_teammate", {
      name: "页面工程师",
      description: "按新结构搭首页静态稿",
      context: "fresh",
      mode: "continuable",
      prompt: BRIEF_BUILDER,
    }),
    call("call_spawn_3", "spawn_teammate", {
      name: "视觉评审",
      description: "首页对比度与法务信息走查",
      context: "fresh",
      mode: "continuable",
      prompt: BRIEF_REVIEWER,
    }),
  ], at(0, 40));

  lead.toolCall("call_spawn_1", "spawn_teammate", { name: "信息架构师", description: "首页内容结构重排", prompt: BRIEF_ARCHITECT }, at(0, 41));
  lead.toolResult("call_spawn_1", "spawned 信息架构师 · mode=continuable", at(0, 42));
  lead.toolCall("call_spawn_2", "spawn_teammate", { name: "页面工程师", description: "按新结构搭首页静态稿", prompt: BRIEF_BUILDER }, at(0, 43));
  lead.toolResult("call_spawn_2", "spawned 页面工程师 · mode=continuable", at(0, 44));
  lead.toolCall("call_spawn_3", "spawn_teammate", { name: "视觉评审", description: "首页对比度与法务信息走查", prompt: BRIEF_REVIEWER }, at(0, 45));
  lead.toolResult("call_spawn_3", "spawned 视觉评审 · mode=continuable", at(0, 46));

  const memberPayload = (id, name, description, label, createdAt) => ({
    id,
    name,
    description,
    phase: "active",
    provider: "spawn",
    context: "fresh",
    mode: "continuable",
    label,
    model: MODEL,
    createdAt,
  });
  lead.ev("team/member", { member: memberPayload(ARCHITECT, "信息架构师", "首页内容结构重排", "信息架构 · 首页结构重排", at(0, 47)) }, at(0, 47));
  lead.ev("team/member", { member: memberPayload(BUILDER, "页面工程师", "按新结构搭首页静态稿", "页面工程 · 首页静态稿", at(0, 49)) }, at(0, 49));
  lead.ev("team/member", { member: memberPayload(REVIEWER, "视觉评审", "首页对比度与法务信息走查", "视觉评审 · 走查与法务", at(0, 51)) }, at(0, 51));

  const task = (id, subject, description, status, ownerId, ownerName, blockedBy, writeScopes) => ({
    id, subject, description, status, ownerId, ownerName,
    blockedBy: blockedBy || [],
    writeScopes: writeScopes || [],
  });

  const tasksTurn1 = [
    task("task-1", "重排首页内容结构（卖点 → 证据 → 报价）", [
      "按「卖点 → 证据 → 报价」重排首页区块，合并同类项，重复卖点只留一处。",
      "",
      "产出：src/content/home.new.md",
      "约束：只改结构，不改文案措辞。",
    ].join("\n"), "completed", ARCHITECT, "信息架构师", [], ["src/content/"]),
    task("task-2", "按新结构搭建首页静态稿", [
      "按 src/content/home.new.md 搭静态稿，先保证 pnpm build 通过。",
      "",
      "复用现有 design token，不引入新依赖。",
    ].join("\n"), "in_progress", BUILDER, "页面工程师", [], ["src/pages/", "src/components/"]),
    task("task-3", "走查对比度与信息层级", [
      "对比度、信息层级、行动按钮唯一性三项走查，结论按「问题 / 影响 / 建议」输出。",
      "",
      "依赖 task-2 的静态稿落地后再开始。",
    ].join("\n"), "pending", REVIEWER, "视觉评审", ["task-2"], ["src/styles/"]),
    task("task-4", "导出旧站文案清单", "把旧站 12 个区块的文案导出成对照表，供新版比对。", "completed", ARCHITECT, "信息架构师", [], ["docs/"]),
  ];
  lead.assistant([
    say("任务拆成 4 条，依赖链是 task-3 等 task-2 完成后才动；另外先导出旧站文案清单做对照。"),
    call("call_task_1", "team_task_create", { subject: tasksTurn1[0].subject, description: tasksTurn1[0].description, writeScopes: tasksTurn1[0].writeScopes }),
    call("call_task_2", "team_task_create", { subject: tasksTurn1[1].subject, description: tasksTurn1[1].description, writeScopes: tasksTurn1[1].writeScopes }),
    call("call_task_3", "team_task_create", { subject: tasksTurn1[2].subject, description: tasksTurn1[2].description, writeScopes: tasksTurn1[2].writeScopes }),
    call("call_task_4", "team_task_create", { subject: tasksTurn1[3].subject, description: tasksTurn1[3].description, writeScopes: tasksTurn1[3].writeScopes }),
  ], at(1, 0));
  ["call_task_1", "call_task_2", "call_task_3", "call_task_4"].forEach((callId, index) => {
    const item = tasksTurn1[index];
    lead.toolCall(callId, "team_task_create", { subject: item.subject, description: item.description }, at(1, 2 + index * 2));
    lead.toolResult(callId, "created " + item.id, at(1, 3 + index * 2));
  });
  tasksTurn1.forEach((item, index) => {
    lead.ev("team/task", { task: item }, at(1, 10 + index * 3));
  });
  lead.turnEnd(at(1, 24));

  /* 第二轮：页脚法务 */
  lead.turnStart(2, at(30, 0));
  lead.user("补一件事：页脚的法务信息（备案号、隐私政策、Cookie 说明）一并补上，别等上线再补。", at(30, 5));
  lead.assistant([
    say("页脚这块交给视觉评审先出清单，task-7 的组件实现先空着，等人认领。"),
    call("call_send_footer", "send_message", {
      agent: "视觉评审",
      message: "页脚法务信息你出个清单：备案号、隐私政策、Cookie 说明，逐条给位置建议。",
    }),
  ], at(30, 12));
  lead.toolCall("call_send_footer", "send_message", { agent: "视觉评审", message: "页脚法务信息你出个清单：备案号、隐私政策、Cookie 说明，逐条给位置建议。" }, at(30, 13));
  lead.toolResult("call_send_footer", "delivered", at(30, 14));

  const tasksTurn2 = [
    task("task-5", "补齐页脚法务信息", "备案号、隐私政策、Cookie 说明三项补齐，位置贴在页脚第二列。", "pending", REVIEWER, "视觉评审", [], ["src/components/Footer.tsx"]),
    task("task-6", "整理页脚文案清单", "逐条给出法务文案与位置建议，交页面工程师实现。", "completed", ARCHITECT, "信息架构师", [], ["docs/"]),
    task("task-7", "页脚组件实现", "把法务信息做成 Footer 组件，移动端折行不溢出。", "pending", "", "", [], ["src/components/"]),
  ];
  lead.assistant([
    say("三条任务建好：task-5 等 task-6 的清单，task-7 还没人认领。"),
    call("call_task_5", "team_task_create", { subject: tasksTurn2[0].subject }),
    call("call_task_6", "team_task_create", { subject: tasksTurn2[1].subject }),
    call("call_task_7", "team_task_create", { subject: tasksTurn2[2].subject }),
  ], at(30, 20));
  tasksTurn2.forEach((item, index) => {
    const callId = "call_task_" + (5 + index);
    lead.toolCall(callId, "team_task_create", { subject: item.subject, description: item.description }, at(30, 21 + index));
    lead.toolResult(callId, "created " + item.id, at(30, 22 + index));
    lead.ev("team/task", { task: item }, at(30, 26 + index));
  });
  lead.assistant([say("我盯着 task-2 的构建，页脚这块等清单回来再派。")], at(31, 10));
  lead.turnEnd(at(31, 12));
  writeSession(lead);

  /* ---------- 信息架构师 ---------- */
  const architect = createSession(ARCHITECT, { createdAt: at(0, 47), parentSession: LEAD_ID, origin: "subagent", depth: 1 });
  architect.ev("subagent/descriptor", { label: "信息架构 · 首页结构重排", agentModel: MODEL, mode: "continuable", context: "fresh", agentName: "信息架构师" }, at(0, 47));
  architect.title("首页内容结构重排", at(0, 48));
  architect.turnStart(1, at(0, 50));
  architect.user(BRIEF_ARCHITECT, at(0, 51));
  architect.assistant([
    think("先摸清现有页面到底有哪些区块，再决定哪些能并、哪些必须留在首屏。"),
    say("先扫一遍现有内容，看区块清单和导航层级。"),
    call("call_a_grep", "grep", { pattern: "<section|aria-label", path: "src/content" }),
  ], at(1, 5));
  architect.toolCall("call_a_grep", "grep", { pattern: "<section|aria-label", path: "src/content" }, at(1, 6));
  architect.toolResult("call_a_grep", "home.md:12:<section aria-label=\"hero\">\nhome.md:48:<section aria-label=\"customers\">\nhome.md:96:<section aria-label=\"pricing\">\nhome.md:151:<section aria-label=\"faq\">\n… 共 12 处", at(1, 7));
  architect.assistant([
    say("12 个区块确认。读一下首页正文，看有没有重复卖点。"),
    call("call_a_read", "read", { file_path: "src/content/home.md" }),
  ], at(1, 20));
  architect.toolCall("call_a_read", "read", { file_path: "src/content/home.md" }, at(1, 21));
  architect.toolResult("call_a_read", "1| # 让团队协作像写代码一样可回滚\n2| \n3| 三分钟接入，支持 12 种工作流…\n…（共 214 行）", at(1, 22));
  architect.assistant([
    think("重复卖点有 3 处：首屏和第二屏都在讲「快」，功能清单里又说了一遍。"),
    say("有 3 处卖点重复，合并后是 9 个区块。开始写新结构。"),
    call("call_a_write", "write", { file_path: "src/content/home.new.md" }),
  ], at(2, 30));
  architect.toolCall("call_a_write", "write", { file_path: "src/content/home.new.md" }, at(2, 31));
  architect.toolResult("call_a_write", "written · src/content/home.new.md · 148 lines", at(2, 32));
  architect.assistant([
    say(STRUCTURE_REPLY),
    call("call_a_send", "send_message", {
      agent: "lead",
      message: "结构稿好了：卖点集中在前 3 屏，证据用客户 logo + 数据，报价放最后。文件 src/content/home.new.md。",
    }),
  ], at(3, 40));
  architect.toolCall("call_a_send", "send_message", { agent: "lead", message: "结构稿好了：卖点集中在前 3 屏，证据用客户 logo + 数据，报价放最后。文件 src/content/home.new.md。" }, at(3, 41));
  architect.toolResult("call_a_send", "delivered", at(3, 42));
  architect.assistant([say("✓ 结构稿交付：src/content/home.new.md（9 区块，卖点 3 屏内讲完）。")], at(4, 10));
  architect.turnEnd(at(4, 12));
  writeSession(architect);

  /* ---------- 页面工程师 ---------- */
  const builder = createSession(BUILDER, { createdAt: at(0, 49), parentSession: LEAD_ID, origin: "subagent", depth: 1 });
  builder.ev("subagent/descriptor", { label: "页面工程 · 首页静态稿", agentModel: MODEL, mode: "continuable", context: "fresh", agentName: "页面工程师" }, at(0, 49));
  builder.title("首页静态稿搭建", at(0, 50));
  builder.turnStart(1, at(1, 2));
  builder.user(BRIEF_BUILDER, at(1, 3));
  builder.assistant([
    say("照结构稿改 index.tsx，先跑通构建再谈样式。"),
    call("call_b_write1", "write", { file_path: "src/pages/index.tsx" }),
  ], at(2, 0));
  builder.toolCall("call_b_write1", "write", { file_path: "src/pages/index.tsx" }, at(2, 1));
  builder.toolResult("call_b_write1", "written · src/pages/index.tsx · 96 lines", at(2, 2));
  builder.assistant([
    say("跑一次构建看看缺什么。"),
    call("call_b_build1", "pwsh", { command: "pnpm build" }),
  ], at(3, 10));
  builder.toolCall("call_b_build1", "pwsh", { command: "pnpm build" }, at(3, 11));
  builder.toolResult("call_b_build1", [
    "> demo-site@0.1.0 build",
    "> tsc -p tsconfig.json && vite build",
    "",
    "src/pages/index.tsx(4,24): error TS2307: Cannot find module '@/components/Footer' or its corresponding type declarations.",
    "",
    "exit code: 2",
  ].join("\n"), at(3, 18), true);
  builder.assistant([
    think("Footer 还没建，先补一个最小空壳，别为了这个改 import 结构。"),
    say("缺 Footer 组件，先补一个空壳再构建。"),
    call("call_b_write2", "write", { file_path: "src/components/Footer.tsx" }),
  ], at(4, 5));
  builder.toolCall("call_b_write2", "write", { file_path: "src/components/Footer.tsx" }, at(4, 6));
  builder.toolResult("call_b_write2", "written · src/components/Footer.tsx · 18 lines", at(4, 7));
  builder.assistant([
    say("再构建一次。"),
    call("call_b_build2", "pwsh", { command: "pnpm build" }),
  ], at(5, 0));
  builder.toolCall("call_b_build2", "pwsh", { command: "pnpm build" }, at(5, 1));
  builder.toolResult("call_b_build2", "vite v6.0.3 build for production\n✓ 34 modules transformed.\n✓ built in 4.2s", at(5, 6));
  builder.assistant([say("构建通过，静态稿能看了。首屏和报价的骨架都按新结构走，等评审的意见再细调。")], at(6, 0));
  builder.turnEnd(at(6, 2));

  builder.turnStart(2, now - 6 * MIN);
  builder.user("评审说正方形头像在小尺寸下对比度不够。顺手把首屏 CTA 的对比度提到 AA，徽标别动。", now - 6 * MIN + 20000);
  builder.assistant([
    say("把 CTA 主色加深一档，先改按钮样式，徽标保持原色。"),
    call("call_b_write3", "write", { file_path: "src/styles/button.css" }),
  ], now - 3 * MIN);
  builder.toolCall("call_b_write3", "write", { file_path: "src/styles/button.css" }, now - 2 * MIN);
  writeSession(builder);

  /* ---------- 视觉评审 ---------- */
  const reviewer = createSession(REVIEWER, { createdAt: at(0, 51), parentSession: LEAD_ID, origin: "subagent", depth: 1 });
  reviewer.ev("subagent/descriptor", { label: "视觉评审 · 走查与法务", agentModel: MODEL, mode: "continuable", context: "fresh", agentName: "视觉评审" }, at(0, 51));
  reviewer.title("首页走查：对比度与法务信息", at(0, 52));
  reviewer.turnStart(1, at(7, 0));
  reviewer.user(BRIEF_REVIEWER, at(7, 2));
  reviewer.assistant([
    think("先看首屏的实际结构，再逐段核对比度；页脚单独过一遍法务三项。"),
    say("先读一遍页面结构，再逐段核对比度。"),
    call("call_r_read", "read", { file_path: "src/pages/index.tsx" }),
  ], at(8, 10));
  reviewer.toolCall("call_r_read", "read", { file_path: "src/pages/index.tsx" }, at(8, 11));
  reviewer.toolResult("call_r_read", "1| import { Hero } from '@/components/Hero'\n2| import { Customers } from '@/components/Customers'\n…（共 96 行）", at(8, 12));
  reviewer.assistant([
    say(REVIEW_REPLY),
    call("call_r_send", "send_message", {
      agent: "lead",
      message: "走查完了：3 处对比度不足（CTA / 辅助文字 / 徽标文字），页脚缺 3 项法务信息。建议先补 CTA 与页脚。",
    }),
  ], at(9, 30));
  reviewer.toolCall("call_r_send", "send_message", { agent: "lead", message: "走查完了：3 处对比度不足（CTA / 辅助文字 / 徽标文字），页脚缺 3 项法务信息。建议先补 CTA 与页脚。" }, at(9, 31));
  reviewer.toolResult("call_r_send", "delivered", at(9, 32));
  reviewer.assistant([say("✓ 走查完成：对比度 3 项、页脚法务 3 项，已按优先级排好。")], at(10, 0));
  reviewer.turnEnd(at(10, 2));

  reviewer.turnStart(2, now - 14 * MIN);
  reviewer.user("页脚法务信息你出个清单：备案号、隐私政策、Cookie 说明，逐条给位置建议。", now - 14 * MIN + 15000);
  reviewer.assistant([
    say([
      "## 页脚法务清单",
      "",
      "1. **备案号** — 页脚最底行左侧，13px，与版权同行",
      "2. **隐私政策** — 页脚第二列第一行，链到 /privacy",
      "3. **Cookie 说明** — 紧跟隐私政策，链到 /cookies",
      "",
      "三项都放在 Footer 组件的 legalLinks 数组里，移动端折行不溢出。",
    ].join("\n")),
  ], now - 12 * MIN);
  reviewer.turnEnd(now - 11 * MIN);
  writeSession(reviewer);
}

/* ---------------------------------------------------------------- 启动 */

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

const args = process.argv.slice(2);
const portIndex = args.findIndex((item) => /^\d+$/.test(item));
const port = portIndex === -1 ? 4320 : Number(args[portIndex]);
const shouldOpen = args.indexOf("--open") !== -1;

fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
buildDemo(Date.now());

const handle = startTeamConsole({ port, sessionsRoot: DEMO_ROOT, maxAgeDays: 365 });
await handle.ready;
const baseUrl = handle.url.replace(/\/+$/, "");
const url = baseUrl + "/?api=" + handle.port;
console.log("示例团队已生成: " + DEMO_ROOT);
console.log("团队: 官网改版 · 三成员协作（3 成员 / 7 任务 / 2 轮派发）");
console.log("打开: " + url);
console.log("按 Ctrl+C 退出（示例数据可以随时删除 demo/sessions）");
if (shouldOpen) openBrowser(url);