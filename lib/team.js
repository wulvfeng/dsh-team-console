/**
 * dsh-team-console — 团队模型层。
 *
 * 数据来源（纯文件，不需要 Host 服务）：
 *   lead 会话日志: team/member 事件 → 名册；team/task 事件 → 共享任务板；
 *                  subagent/catalog 事件 → 子会话标签；user/assistant/tool 事件 → 会话流。
 *   子会话日志:    subagent/descriptor → 角色标签/模型；同样的事件流。
 */
import { isArchivedSession, readArchivedSessionIds } from "./archive.js";
import {
  defaultSessionsRoot,
  listSessionDirs,
  listSessionHeaders,
  readSessionEvents,
  readSessionSummary,
  resolveSessionFile,
} from "./sessions.js";

const CONTEXT_PREFIX = "Current runtime context.";
/**
 * 成员超过 10 分钟没有任何新事件（崩溃 / 中断 / 已结束）就不再算"正在做什么"，
 * 否则残留的 turn/start + tool/call 会让它永远显示"正在调用 X"。
 */
const STALE_MS = 10 * 60 * 1000;
const CONTEXT_SOURCE_KINDS = new Set([
  "runtime-context",
  "skill-catalog",
  "time-context",
  "subagent-context",
]);

/** 判断一条用户消息是不是系统注入的运行时上下文/提醒（而非真人输入）。 */
export function isContextText(text, source) {
  if (source && typeof source.kind === "string" && CONTEXT_SOURCE_KINDS.has(source.kind)) {
    return true;
  }
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith(CONTEXT_PREFIX)) return true;
  if (trimmed.startsWith("<system-reminder>")) return true;
  if (trimmed.startsWith("<available_skills>")) return true;
  if (/^Time sampled while preparing/.test(trimmed)) return true;
  if (/^Agent Teams is available/.test(trimmed)) return true;
  if (/^Current runtime context/.test(trimmed)) return true;
  return false;
}

/** 从 message content parts（或字符串）里取纯文本。 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function clip(text, max) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join("") + "…" : text;
}

function titleOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "session/title" && event.data && typeof event.data.title === "string") {
      return event.data.title;
    }
  }
  for (const event of events) {
    if (event.type === "user/message") {
      const data = event.data || {};
      const text = textOf(data.content).trim();
      if (text && !isContextText(text, data.source)) return clip(text.split("\n")[0], 80);
    }
  }
  return "(未命名会话)";
}

/** 把工具参数压成一行摘要 + 完整 JSON。 */
export function summarizeToolArgs(name, rawArgs, maxBody) {
  const bodyLimit = typeof maxBody === "number" ? maxBody : 6000;
  let parsed = null;
  try {
    parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  } catch {
    parsed = null;
  }
  let headline = "";
  if (parsed && typeof parsed === "object") {
    const firstLine = (value) => (typeof value === "string" ? clip(value.split("\n")[0], 120) : "");
    headline =
      firstLine(parsed.description) ||
      firstLine(parsed.file_path) ||
      firstLine(parsed.path) ||
      firstLine(parsed.command) ||
      firstLine(parsed.query) ||
      firstLine(parsed.pattern) ||
      firstLine(parsed.url) ||
      firstLine(parsed.subject) ||
      firstLine(parsed.target) ||
      firstLine(parsed.agent) ||
      firstLine(parsed.message) ||
      firstLine(parsed.code);
  } else if (typeof rawArgs === "string") {
    headline = clip(rawArgs.split("\n")[0], 120);
  }
  let pretty = "";
  if (parsed && typeof parsed === "object") {
    try {
      pretty = JSON.stringify(parsed, null, 2);
    } catch {
      pretty = String(rawArgs);
    }
  } else {
    pretty = typeof rawArgs === "string" ? rawArgs : "";
  }
  return { headline, body: clip(pretty, bodyLimit) };
}

function resultText(message) {
  if (!message) return "";
  const fromParts = textOf(message.content);
  if (fromParts) return fromParts;
  if (typeof message.content === "string") return message.content;
  return "";
}

/** 由事件流推导"成员此刻在做什么"。 */
export function activityOf(events) {
  const pendingTools = new Map();
  const pendingPtc = new Map();
  let lastTime = 0;
  let lastType = "";
  let lastPreview = "";
  let model = "";
  let turnOpen = false;
  for (const event of events) {
    if (typeof event.time === "number") lastTime = Math.max(lastTime, event.time);
    lastType = event.type;
    const data = event.data || {};
    if (event.type === "subagent/descriptor" && data.agentModel) model = data.agentModel;
    if (event.type === "assistant/message") {
      const message = data.message || {};
      if (message.source && message.source.model) model = message.source.model;
      const text = textOf(message.content);
      if (text) lastPreview = clip(text.replace(/\s+/g, " "), 160);
    }
    if (event.type === "turn/start") {
      turnOpen = true;
    }
    if (event.type === "turn/end") {
      turnOpen = false;
      pendingTools.clear();
      pendingPtc.clear();
    }
    if (event.type === "tool/call") {
      const callId = data.callId || ("seq:" + event.seq);
      pendingTools.set(callId, { name: data.name, time: event.time });
    }
    if (event.type === "tool/result") {
      const callId = data.toolCallId || (data.message && data.message.toolCallId);
      pendingTools.delete(callId);
      pendingPtc.clear();
    }
    if (event.type === "tool/ptc-dispatch-start" && data.subCallId) {
      pendingPtc.set(data.subCallId, { name: data.name, time: event.time });
    }
    if (event.type === "tool/ptc-dispatch" && data.subCallId) {
      pendingPtc.delete(data.subCallId);
    }
  }
  const open = [...pendingTools.values()];
  const openSub = [...pendingPtc.values()];
  const last = open.length > 0 ? open[open.length - 1] : null;
  const lastSub = openSub.length > 0 ? openSub[openSub.length - 1] : null;
  let kind = "idle";
  let label = "空闲";
  if (last) {
    kind = "tool";
    label = "正在调用 " + last.name + (lastSub && lastSub.name ? " · " + lastSub.name : "");
  } else if (turnOpen) {
    kind = "thinking";
    label = "正在思考";
  }
  const stale = Boolean(kind !== "idle" && lastTime > 0 && Date.now() - lastTime > STALE_MS);
  if (stale) label = label + "（10 分钟无新事件）";
  return {
    kind,
    label,
    stale,
    tool: last ? last.name : null,
    sinceMs: last && last.time ? last.time : null,
    lastTime: lastTime || null,
    lastType,
    lastPreview,
    model,
    openTools: open.length,
  };
}

function collectTeamState(events, teamId) {
  const members = new Map();
  const tasks = new Map();
  const catalog = new Map();
  for (const event of events) {
    const data = event.data || {};
    if (event.type && event.type.indexOf("team/") === 0) {
      if (teamId && data.teamId && data.teamId !== teamId) continue;
    }
    if (event.type === "team/member" && data.member && data.member.id) {
      const previous = members.get(data.member.id) || {};
      members.set(data.member.id, Object.assign({}, previous, data.member));
    }
    if (event.type === "team/task" && data.task && data.task.id) {
      const previous = tasks.get(data.task.id) || {};
      tasks.set(data.task.id, Object.assign({}, previous, data.task));
    }
    if (event.type === "subagent/catalog" && data.childId) {
      catalog.set(data.childId, data);
    }
  }
  return { members: [...members.values()], tasks: [...tasks.values()], catalog };
}

/** 自然排序 task-1, task-2, ..., task-10 */
function compareTaskIds(a, b) {
  const idA = String(a && a.id ? a.id : a || "");
  const idB = String(b && b.id ? b.id : b || "");
  const ma = /^task-(\d+)$/.exec(idA);
  const mb = /^task-(\d+)$/.exec(idB);
  if (ma && mb) return Number(ma[1]) - Number(mb[1]);
  return idA.localeCompare(idB);
}

/** file -> {mtimeMs,size,entry|null}：未变化的团队会话不必重新解码。 */
const leadSummaryCache = new Map();
/** 团队列表的短 TTL 缓存，压掉 2s 轮询的重复全量扫描；sync / async 分开，避免互相污染。 */
let indexListCacheSync = { key: "", at: 0, data: [] };
let indexListCacheAsync = { key: "", at: 0, data: [] };

/** maxAgeDays 归一化：只接受有限正数，否则回退 14（防直接调用方传 NaN 静默关掉时间过滤）。 */
function normalizeMaxAgeDays(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 14;
}

/** 同一 lead 目录可能出现在多个 workspace：按 leadId 去重，保留 updatedAt 最新的一条。 */
function dedupeTeamsByLead(list) {
  const byLead = new Map();
  for (const team of list) {
    const previous = byLead.get(team.leadId);
    if (!previous || (team.updatedAt || 0) > (previous.updatedAt || 0)) byLead.set(team.leadId, team);
  }
  return [...byLead.values()];
}

function summarizeLeadFile(entry) {
  const summary = readSessionSummary(entry.file);
  if (!summary.isLead) return null;
  const header = summary.header;
  if (!header || !header.id) return null;
  const activeTasks = summary.tasks.filter((task) => task.status !== "deleted");
  const openTasks = activeTasks.filter((task) => task.status !== "completed");
  return {
    leadId: header.id,
    title: summary.title || "(未命名会话)",
    cwd: header.cwd || "",
    createdAt: header.createdAt || 0,
    updatedAt: entry.mtimeMs,
    memberCount: summary.members.length,
    taskCount: activeTasks.length,
    openTaskCount: openTasks.length,
    members: summary.members.map((member) => ({ id: member.id, name: member.name, phase: member.phase })),
  };
}

function getCachedLeadSummary(entry) {
  const cached = leadSummaryCache.get(entry.file);
  if (cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) {
    return cached.entry;
  }
  const summary = summarizeLeadFile(entry);
  leadSummaryCache.set(entry.file, { mtimeMs: entry.mtimeMs, size: entry.size, entry: summary });
  return summary;
}

/** 扫描所有带团队的 lead 会话，生成团队列表（文件级摘要缓存 + 归档过滤 + 5s 列表 TTL）。 */
export async function buildTeamIndexAsync(options) {
  const opts = options || {};
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot();
  const maxAgeDays = normalizeMaxAgeDays(opts.maxAgeDays);
  const includeArchived = opts.includeArchived === true;
  const archiveFile = opts.archiveFile || "";
  const cacheKey = [sessionsRoot, maxAgeDays, includeArchived ? "1" : "0", archiveFile].join("|");
  if (indexListCacheAsync.key === cacheKey && Date.now() - indexListCacheAsync.at < 5000) {
    return indexListCacheAsync.data;
  }
  const archivedIds = includeArchived ? new Set() : readArchivedSessionIds({ sessionsRoot, archiveFile });
  const cutoffAsync = Date.now() - maxAgeDays * 86400000;
  const teamsAsync = [];
  const seenAsync = new Set();
  const dirEntries = listSessionDirs(sessionsRoot);
  const byFile = new Map(dirEntries.map((d) => [d.file, d]));
  let counter = 0;
  for (const entry of dirEntries) {
    if (entry.mtimeMs < cutoffAsync) continue;
    seenAsync.add(entry.file);
    const summaryAsync = getCachedLeadSummary(entry);
    if (summaryAsync && !archivedIds.has(summaryAsync.leadId)) {
      teamsAsync.push(summaryAsync);
    }
    counter += 1;
    if (counter % 2 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  if (leadSummaryCache.size > 200) {
    for (const key of [...leadSummaryCache.keys()]) {
      if (!seenAsync.has(key)) leadSummaryCache.delete(key);
    }
  }
  const knownLeads = new Set(teamsAsync.map((team) => team.leadId));
  treeChildren(sessionsRoot).forEach((children, leadId) => {
    if (knownLeads.has(leadId) || children.length === 0) return;
    if (archivedIds.has(leadId)) return;
    const activeChildren = children.filter((child) => !archivedIds.has(child.id));
    if (activeChildren.length === 0) return;
    const newest = activeChildren.reduce((acc, child) => Math.max(acc, child.mtimeMs || 0), 0);
    if (newest < cutoffAsync) return;
    const leadFile = resolveSessionFile(sessionsRoot, leadId);
    if (!leadFile) return;
    const dirEntry = byFile.get(leadFile);
    const cachedLead = dirEntry ? getCachedLeadSummary(dirEntry) : null;
    if (cachedLead) return;
    const summary = readSessionSummary(leadFile);
    if (!summary.header) return;
    const activeTasks = (summary.tasks || []).filter((t) => t.status !== "deleted");
    const openTasks = activeTasks.filter((t) => t.status !== "completed");
    teamsAsync.push({
      leadId,
      title: summary.title || "本次协作",
      cwd: summary.header.cwd || "",
      createdAt: summary.header.createdAt || 0,
      updatedAt: newest || summary.header.createdAt || 0,
      memberCount: activeChildren.length,
      taskCount: activeTasks.length,
      openTaskCount: openTasks.length,
      members: activeChildren.map((child, index) => ({ id: child.id, name: "成员 " + (index + 1), phase: "active" })),
      source: "session-tree",
    });
  });
  const dedupedAsync = dedupeTeamsByLead(teamsAsync);
  dedupedAsync.sort((a, b) => b.updatedAt - a.updatedAt);
  const dataAsync = dedupedAsync.slice(0, 50);
  indexListCacheAsync = { key: cacheKey, at: Date.now(), data: dataAsync };
  return dataAsync;
}

/** 同步版本（测试用）。 */
export function buildTeamIndex(options) {
  const opts = options || {};
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot();
  const maxAgeDays = normalizeMaxAgeDays(opts.maxAgeDays);
  const includeArchived = opts.includeArchived === true;
  const archiveFile = opts.archiveFile || "";
  const cacheKey = [sessionsRoot, maxAgeDays, includeArchived ? "1" : "0", archiveFile].join("|");
  if (indexListCacheSync.key === cacheKey && Date.now() - indexListCacheSync.at < 5000) {
    return indexListCacheSync.data;
  }
  const archivedIds = includeArchived ? new Set() : readArchivedSessionIds({ sessionsRoot, archiveFile });
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const teams = [];
  const seen = new Set();
  for (const entry of listSessionDirs(sessionsRoot)) {
    if (entry.mtimeMs < cutoff) continue;
    seen.add(entry.file);
    const summary = getCachedLeadSummary(entry);
    if (summary && !archivedIds.has(summary.leadId)) teams.push(summary);
  }
  if (leadSummaryCache.size > 200) {
    for (const key of [...leadSummaryCache.keys()]) {
      if (!seen.has(key)) leadSummaryCache.delete(key);
    }
  }
  const deduped = dedupeTeamsByLead(teams);
  deduped.sort((a, b) => b.updatedAt - a.updatedAt);
  const data = deduped.slice(0, 50);
  indexListCacheSync = { key: cacheKey, at: Date.now(), data };
  return data;
}

const ASSIGNMENT_TOOLS = new Set([
  "spawn_teammate",
  "subagent",
  "subagent_fork",
  "team_task_create",
  "team_task_update",
  "send_message",
  "interrupt_agent",
]);

/**
 * 从 lead 会话的工具调用（含 PTC tool/ptc-dispatch）里还原"我给他们分配了什么任务"。
 */
function extractAssignments(events) {
  const byMember = new Map();
  const byTask = new Map();
  const timeline = [];
  for (const event of events) {
    if (event.type !== "tool/call" && event.type !== "tool/ptc-dispatch") continue;
    const data = event.data || {};
    const name = data.name || "";
    if (!ASSIGNMENT_TOOLS.has(name)) continue;
    let args = null;
    try {
      args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
    } catch {
      args = null;
    }
    if (!args || typeof args !== "object") continue;
    const entry = { tool: name, at: event.time || null, args };
    timeline.push(entry);
    if ((name === "spawn_teammate" || name === "subagent" || name === "subagent_fork") && args.name) {
      byMember.set(args.name, { description: args.description || "", prompt: args.prompt || "", at: event.time || null });
    }
    if (name === "team_task_create" && args.subject) {
      byTask.set(args.subject, { description: args.description || "", writeScopes: args.writeScopes || [], at: event.time || null });
    }
  }
  return { byMember, byTask, timeline };
}

/** 成员做过的事：按工具调用还原一条紧凑时间线。 */
function memberSteps(events) {
  const steps = [];
  const index = new Map();
  for (const event of events) {
    const data = event.data || {};
    if (event.type === "tool/call") {
      const summary = summarizeToolArgs(data.name, data.arguments, 400);
      const step = {
        callId: data.callId || "",
        name: data.name || "",
        headline: summary.headline,
        at: event.time || null,
        ok: null,
        error: false,
      };
      if (data.callId) index.set(data.callId, step);
      steps.push(step);
      continue;
    }
    if (event.type === "tool/result") {
      const message = data.message || {};
      const callId = data.toolCallId || message.toolCallId || "";
      const step = callId ? index.get(callId) : null;
      if (step) {
        step.ok = message.isError !== true;
        step.error = message.isError === true;
        step.resultAt = event.time || null;
        step.resultText = clip(resultText(message), 600);
      }
    }
  }
  return steps.slice(0, 60);
}

function memberSummary(member, sessionsRoot) {
  const file = resolveSessionFile(sessionsRoot, member.id);
  const events = file ? readSessionEvents(file) : [];
  const activity = activityOf(events);
  let descriptor = {};
  for (const event of events) {
    if (event.type === "subagent/descriptor") descriptor = event.data || {};
  }
  const header = events[0] || {};
  const toolCalls = events.filter((event) => event.type === "tool/call").length;
  const steps = memberSteps(events);
  const replies = [];
  let lastAssistant = "";
  for (const event of events) {
    const data = event.data || {};
    if (event.type === "assistant/message") {
      const message = data.message || {};
      const text = textOf(message.content).trim();
      if (text) lastAssistant = clip(text, 1500);
    }
    if (event.type !== "tool/call" && event.type !== "tool/ptc-dispatch") continue;
    if (data.name !== "send_message") continue;
    let args = null;
    try {
      args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
    } catch {
      args = null;
    }
    if (args && args.message) replies.push({ text: clip(String(args.message), 1500), at: event.time || null });
  }
  if (replies.length === 0 && lastAssistant) replies.push({ text: lastAssistant, at: null });
  let firstPrompt = "";
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const data = event.data || {};
    const text = textOf(data.content).trim();
    if (!text || isContextText(text, data.source)) continue;
    firstPrompt = clip(text, 4000);
    break;
  }
  const messages = events.filter((event) => event.type === "assistant/message").length;
  return {
    label: descriptor.label || member.description || "",
    mode: descriptor.mode || "",
    model: descriptor.agentModel || activity.model || "",
    createdAt: header.createdAt || null,
    hasLog: events.length > 0,
    toolCalls,
    messages,
    activity,
    steps,
    firstPrompt,
    replies,
    title: events.length > 0 ? titleOf(events) : "",
  };
}

/** 丰富任务视图：过滤已删除任务，解析 owner（含 lead）、就绪/阻塞状态与依赖标签。 */
function enrichTasks(rawTasks, members, leadId, leadActivity, teamId) {
  const visible = rawTasks.filter((task) => task && task.status !== "deleted");
  const completed = new Set(visible.filter((task) => task.status === "completed").map((task) => task.id));
  // 依赖指向已删除/不存在任务时视为"已解除"，否则该任务永远 blocked。
  const visibleIds = new Set(visible.map((task) => task.id));
  const tasks = visible
    .map((task) => {
      const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
      const ready = task.status === "pending" && blockedBy.every((id) => completed.has(id) || !visibleIds.has(id));
      return Object.assign({}, task, {
        blockedBy,
        writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes : [],
        ready,
        blocked: task.status === "pending" && !ready,
      });
    })
    .sort(compareTaskIds);

  const byName = new Map(members.map((member) => [member.name, member]));
  const byId = new Map(members.map((member) => [member.id, member]));
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));

  tasks.forEach((task) => {
    const isLeadOwner = (leadId && task.ownerId === leadId) || (teamId && task.ownerId === teamId) || task.ownerName === "lead";
    const owner = (task.ownerId && byId.get(task.ownerId)) || (task.ownerName && byName.get(task.ownerName)) || null;
    if (owner) {
      task.ownerId = owner.id;
      task.ownerName = owner.name;
      task.ownerPhase = owner.phase;
      task.ownerActivity = owner.activity ? owner.activity.label : "";
      task.ownerActivityKind = owner.activity ? owner.activity.kind : "";
    } else if (isLeadOwner) {
      task.ownerId = leadId;
      task.ownerName = "lead";
      task.ownerPhase = "active";
      task.ownerActivity = leadActivity ? leadActivity.label : "";
      task.ownerActivityKind = leadActivity ? leadActivity.kind : "";
    } else {
      task.ownerId = task.ownerId || null;
      task.ownerName = task.ownerName || null;
      task.ownerPhase = null;
      task.ownerActivity = "";
      task.ownerActivityKind = "";
    }
    task.blockerOwners = (task.blockedBy || []).map((id) => {
      const blocker = byTaskId.get(id);
      return blocker && blocker.ownerName ? blocker.ownerName : null;
    }).filter(Boolean);
    task.blockerLabels = (task.blockedBy || []).map((id) => {
      const blocker = byTaskId.get(id);
      if (!blocker) return id + "（已删除）";
      const ownerLabel = blocker.ownerName ? " · " + blocker.ownerName : "";
      return id + ownerLabel;
    });
  });

  return tasks;
}

/**
 * 把 lead 会话按"我发出的请求"（user turn）分组成任务组：
 * 每一轮用户请求下挂它派生的成员与任务，方便多个请求并行时分别管理。
 */
function buildRequests(events, teamId) {
  const groups = new Map();
  let currentTurn = 0;
  const seenMembers = new Set();
  const seenTasks = new Set();
  function group(turn) {
    if (!groups.has(turn)) groups.set(turn, { turn, title: "", time: 0, memberIds: [], taskIds: [] });
    return groups.get(turn);
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const data = event.data || {};
    if (event.type === "turn/start") {
      currentTurn = typeof data.turn === "number" ? data.turn : currentTurn + 1;
      continue;
    }
    if (event.type === "user/message") {
      const text = textOf(data.content).trim();
      if (text && !isContextText(text, data.source)) {
        const g = group(currentTurn);
        if (!g.title) {
          g.title = clip(text.replace(/\s+/g, " "), 64);
          g.time = event.time || 0;
        }
      }
      continue;
    }
    if (event.type === "team/member" && data.member && data.member.id) {
      if (teamId && data.teamId && data.teamId !== teamId) continue;
      if (!seenMembers.has(data.member.id)) {
        seenMembers.add(data.member.id);
        group(currentTurn).memberIds.push(data.member.id);
      }
      continue;
    }
    if (event.type === "team/task" && data.task && data.task.id) {
      if (teamId && data.teamId && data.teamId !== teamId) continue;
      if (!seenTasks.has(data.task.id)) {
        seenTasks.add(data.task.id);
        group(currentTurn).taskIds.push(data.task.id);
      }
    }
  }
  const list = [];
  groups.forEach((value) => {
    if (!value.title && value.memberIds.length === 0 && value.taskIds.length === 0) return;
    if (!value.title) value.title = value.memberIds.length > 0 ? "（派发成员）" : "（创建任务）";
    list.push(value);
  });
  list.sort((a, b) => a.turn - b.turn);
  return list;
}

/** 组装一个团队的完整视图：名册 + 任务板 + lead 摘要。 */
export function buildTeamModel(options) {
  const opts = options || {};
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot();
  const leadId = opts.leadId;
  const leadFile = leadId ? resolveSessionFile(sessionsRoot, leadId) : null;
  if (!leadFile) return null;
  const leadEvents = readSessionEvents(leadFile);
  if (leadEvents.length === 0) return null;
  const header = leadEvents[0] || {};
  const teamId = header.id || leadId;
  const state = collectTeamState(leadEvents, teamId);
  const leadActivity = activityOf(leadEvents);

  const visibleRawTasks = state.tasks.filter((task) => task && task.status !== "deleted");
  const visibleTaskIds = new Set(visibleRawTasks.map((t) => t.id));

  const members = state.members.map((member) => {
    const summary = memberSummary(member, sessionsRoot);
    const owned = visibleRawTasks.filter((task) => task.ownerId === member.id || (task.ownerName && task.ownerName === member.name));
    return Object.assign({ id: member.id, name: member.name, description: member.description || "" }, member, summary, {
      taskIds: owned.map((task) => task.id),
      activeTaskIds: owned.filter((task) => task.status === "in_progress").map((task) => task.id),
    });
  });

  const tasks = enrichTasks(visibleRawTasks, members, leadId, leadActivity, teamId);
  const assignments = extractAssignments(leadEvents);
  const requests = buildRequests(leadEvents, teamId);
  const turnOfMember = new Map();
  const turnOfTask = new Map();
  requests.forEach((request) => {
    request.memberIds.forEach((id) => { if (!turnOfMember.has(id)) turnOfMember.set(id, request.turn); });
    request.taskIds.forEach((id) => { if (!turnOfTask.has(id)) turnOfTask.set(id, request.turn); });
  });
  members.forEach((member) => {
    member.turn = turnOfMember.has(member.id) ? turnOfMember.get(member.id) : null;
    const assign = assignments.byMember.get(member.name);
    member.assignment = {
      description: (assign && assign.description) || member.description || member.label || "",
      prompt: (assign && assign.prompt) || member.firstPrompt || "",
      at: (assign && assign.at) || member.createdAt || null,
      replies: member.replies || [],
    };
    const steps = member.steps || [];
    member.stepCount = steps.length;
    member.failedSteps = steps.filter((step) => step.error).length;
  });
  tasks.forEach((task) => {
    task.turn = turnOfTask.has(task.id) ? turnOfTask.get(task.id) : null;
  });

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const requestViews = requests
    .map((request) => {
      const keptTaskIds = request.taskIds.filter((id) => visibleTaskIds.has(id));
      return {
        turn: request.turn,
        title: request.title,
        time: request.time || null,
        memberIds: request.memberIds,
        taskIds: keptTaskIds,
        memberCount: request.memberIds.length,
        taskCount: keptTaskIds.length,
        activeTaskCount: keptTaskIds.filter((id) => {
          const t = taskById.get(id);
          return t && t.status === "in_progress";
        }).length,
      };
    })
    .filter((request) => request.memberIds.length > 0 || request.taskIds.length > 0);

  const groupedMemberIds = new Set();
  const groupedTaskIds = new Set();
  requestViews.forEach((request) => {
    request.memberIds.forEach((id) => groupedMemberIds.add(id));
    request.taskIds.forEach((id) => groupedTaskIds.add(id));
  });
  const orphanMembers = members.filter((member) => !groupedMemberIds.has(member.id)).map((member) => member.id);
  const orphanTasks = tasks.filter((task) => !groupedTaskIds.has(task.id)).map((task) => task.id);
  if (orphanMembers.length > 0 || orphanTasks.length > 0) {
    requestViews.push({
      turn: 0,
      title: "未归类（更早的历史）",
      time: null,
      memberIds: orphanMembers,
      taskIds: orphanTasks,
      memberCount: orphanMembers.length,
      taskCount: orphanTasks.length,
      activeTaskCount: orphanTasks.filter((id) => {
        const t = taskById.get(id);
        return t && t.status === "in_progress";
      }).length,
    });
  }
  return {
    leadId,
    archived: isArchivedSession(leadId, { sessionsRoot, archiveFile: opts.archiveFile }),
    title: titleOf(leadEvents),
    cwd: header.cwd || "",
    agentPreset: header.agentPreset || "",
    createdAt: header.createdAt || 0,
    model: leadActivity.model || "",
    lead: {
      id: leadId,
      title: titleOf(leadEvents),
      activity: leadActivity,
      taskIds: tasks.map((task) => task.id),
    },
    members,
    tasks,
    requests: requestViews,
    dispatches: [].concat(
      assignments.timeline.map((item) => ({
        tool: item.tool,
        at: item.at,
        target: item.args.name || item.args.target || item.args.agent || item.args.subject || "",
        summary: item.args.description || item.args.message || item.args.subject || "",
      })),
      state.members.map((member) => ({
        tool: "spawn",
        at: member.createdAt || null,
        target: member.name || member.id,
        summary: member.description || "",
      })),
      tasks.map((task) => ({
        tool: "task",
        at: null,
        target: task.id,
        summary: (task.subject || "") + (task.ownerName ? " → " + task.ownerName : ""),
      }))
    ),
    generatedAt: Date.now(),
  };
}

/** 把一个会话日志规范化成前端可直接渲染的条目流。 */
export function sessionTranscript(options) {
  const opts = options || {};
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot();
  const sessionId = opts.sessionId;
  const limit = typeof opts.limit === "number" ? opts.limit : 200;
  const file = sessionId ? resolveSessionFile(sessionsRoot, sessionId) : null;
  if (!file) return null;
  const events = readSessionEvents(file);
  if (events.length === 0) return null;
  const header = events[0] || {};
  const items = [];
  const toolItems = new Map();
  let descriptor = {};
  for (const event of events) {
    const data = event.data || {};
    const base = { seq: event.seq, time: event.time || null };
    if (event.type === "subagent/descriptor") descriptor = data;
    if (event.type === "user/message") {
      const text = textOf(data.content).trim();
      if (!text) continue;
      items.push(Object.assign({}, base, {
        id: "u" + event.seq,
        kind: isContextText(text, data.source) ? "context" : "user",
        text: clip(text, 6000),
      }));
      continue;
    }
    if (event.type === "assistant/message") {
      const message = data.message || {};
      const parts = Array.isArray(message.content) ? message.content : [];
      let index = 0;
      for (const part of parts) {
        if (part.type === "text" && part.text) {
          items.push(Object.assign({}, base, { id: "a" + event.seq + "-" + index, kind: "assistant", text: clip(part.text, 6000) }));
          index += 1;
        } else if (part.type === "reasoning" && part.text) {
          items.push(Object.assign({}, base, { id: "r" + event.seq + "-" + index, kind: "reasoning", text: clip(part.text, 6000) }));
          index += 1;
        } else if (part.type === "tool-call") {
          const summary = summarizeToolArgs(part.name, part.arguments, 2500);
          const item = Object.assign({}, base, {
            id: "t" + event.seq + "-" + index,
            kind: "tool",
            name: part.name,
            callId: part.id || "",
            headline: summary.headline,
            args: summary.body,
            result: null,
            isError: false,
          });
          if (part.id) toolItems.set(part.id, item);
          items.push(item);
          index += 1;
        }
      }
      continue;
    }
    if (event.type === "tool/call") {
      if (data.callId && toolItems.has(data.callId)) continue;
      const summary = summarizeToolArgs(data.name, data.arguments, 2500);
      const item = Object.assign({}, base, {
        id: "tc" + event.seq,
        kind: "tool",
        name: data.name || "",
        callId: data.callId || "",
        headline: summary.headline,
        args: summary.body,
        result: null,
        isError: false,
      });
      if (data.callId) toolItems.set(data.callId, item);
      items.push(item);
      continue;
    }
    if (event.type === "tool/ptc-dispatch") {
      const parentId = data.parentCallId || data.rootCallId || "";
      const parentItem = parentId ? toolItems.get(parentId) : null;
      if (parentItem) {
        if (!Array.isArray(parentItem.subSteps)) parentItem.subSteps = [];
        const subSummary = summarizeToolArgs(data.name, data.arguments, 400);
        parentItem.subSteps.push({
          name: data.name || "",
          headline: subSummary.headline,
          isError: data.isError === true,
        });
      }
      continue;
    }
    if (event.type === "tool/result") {
      const message = data.message || {};
      const callId = data.toolCallId || message.toolCallId || "";
      const target = toolItems.get(callId);
      const text = clip(resultText(message), 4000);
      if (target) {
        target.result = text;
        target.isError = message.isError === true;
        if (event.time) target.resultTime = event.time;
      } else {
        items.push(Object.assign({}, base, { id: "tr" + event.seq, kind: "tool_result", callId, text, isError: message.isError === true }));
      }
      continue;
    }
    if (event.type === "team/member") {
      const member = data.member || {};
      items.push(Object.assign({}, base, { id: "m" + event.seq, kind: "team", text: "成员 " + (member.name || member.id) + " → " + (member.phase || "?") }));
      continue;
    }
    if (event.type === "team/task") {
      const task = data.task || {};
      items.push(Object.assign({}, base, {
        id: "k" + event.seq,
        kind: "team",
        text: "任务 " + (task.id || "?") + " " + (task.subject || "") + " → " + (task.status || "?"),
      }));
      continue;
    }
    if (event.type === "team/message/queued") {
      const msg = data.message || {};
      const preview = clip(textOf(msg.content).replace(/\s+/g, " "), 80);
      items.push(Object.assign({}, base, {
        id: "mq" + event.seq,
        kind: "team",
        text: "消息 " + (msg.senderName || "?") + " → " + (msg.targetId || "?") + (preview ? "：" + preview : ""),
      }));
    }
  }
  const total = items.length;
  const truncated = total > limit;
  const sliced = truncated ? items.slice(total - limit) : items;
  const activity = activityOf(events);
  return {
    id: sessionId,
    kind: header.origin === "subagent" ? "member" : "lead",
    title: titleOf(events),
    label: descriptor.label || "",
    parentSession: header.parentSession || null,
    delegationDepth: header.delegationDepth || 0,
    cwd: header.cwd || "",
    createdAt: header.createdAt || null,
    agentPreset: header.agentPreset || "",
    model: descriptor.agentModel || activity.model || "",
    activity,
    total,
    truncated,
    items: sliced,
  };
}

/** 按"子会话的 parentSession"还原团队：不依赖 team/* 事件。 */
function treeChildren(sessionsRoot) {
  const byParent = new Map();
  for (const header of listSessionHeaders(sessionsRoot)) {
    if (!header.parentSession) continue;
    const list = byParent.get(header.parentSession) || [];
    list.push(header);
    byParent.set(header.parentSession, list);
  }
  return byParent;
}

/** 用会话树兜底组装团队（members 来自子会话，tasks 来自 team/task 事件若有）。 */
export function buildTreeTeamModel(options) {
  const opts = options || {};
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot();
  const leadId = opts.leadId;
  if (!leadId) return null;
  const leadFile = resolveSessionFile(sessionsRoot, leadId);
  if (!leadFile) return null;
  const summary = readSessionSummary(leadFile);
  const leadEvents = readSessionEvents(leadFile);
  if (leadEvents.length === 0) return null;
  const archivedIds = opts.includeArchived === true ? new Set() : readArchivedSessionIds({ sessionsRoot, archiveFile: opts.archiveFile });
  const children = (treeChildren(sessionsRoot).get(leadId) || [])
    .filter((child) => !archivedIds.has(child.id))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  if (children.length === 0) return null;
  const header = leadEvents[0] || {};
  const teamId = header.id || leadId;
  const state = collectTeamState(leadEvents, teamId);
  const leadActivity = activityOf(leadEvents);

  const members = children.map((child, index) => {
    const detail = memberSummary({ id: child.id, description: "", name: "" }, sessionsRoot);
    const cat = state.catalog.get(child.id) || {};
    const label = detail.label || cat.label || "";
    const phase = detail.hasLog
      ? (detail.activity && detail.activity.kind !== "idle" && detail.activity.stale !== true ? "active" : "inactive")
      : "provisioning";
    return Object.assign({
      id: child.id,
      name: label || "成员 " + (index + 1),
      description: label,
      phase,
      turn: null,
    }, detail, {
      assignment: {
        description: label,
        prompt: detail.firstPrompt || "",
        at: child.createdAt || null,
        replies: detail.replies || [],
      },
      stepCount: (detail.steps || []).length,
      failedSteps: (detail.steps || []).filter((step) => step.error).length,
    });
  });

  const tasks = enrichTasks(state.tasks, members, leadId, leadActivity, teamId);
  const requests = [{
    turn: 1,
    title: summary.title || "本次协作",
    time: children[0].createdAt || null,
    memberIds: members.map((member) => member.id),
    taskIds: tasks.map((task) => task.id),
    memberCount: members.length,
    taskCount: tasks.length,
    activeTaskCount: tasks.filter((task) => task.status === "in_progress").length,
  }];
  return {
    leadId,
    archived: isArchivedSession(leadId, { sessionsRoot, archiveFile: opts.archiveFile }),
    title: summary.title || "本次协作",
    cwd: (summary.header && summary.header.cwd) || "",
    agentPreset: (summary.header && summary.header.agentPreset) || "",
    createdAt: (summary.header && summary.header.createdAt) || 0,
    model: leadActivity.model || "",
    lead: { id: leadId, title: summary.title || "本次协作", activity: leadActivity, taskIds: tasks.map((task) => task.id) },
    members,
    tasks,
    requests,
    dispatches: members.map((member) => ({ tool: "spawn", at: member.createdAt || null, target: member.name, summary: member.description || "" })),
    generatedAt: Date.now(),
    source: "session-tree",
  };
}
