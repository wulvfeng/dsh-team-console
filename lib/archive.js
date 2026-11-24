/**
 * dsh-team-console — 归档状态读取层。
 *
 * DSH 的「归档」不是把会话文件删掉，而是记在 workspace 域存储里：
 *   <home>/storages/workspace.json → global.archivedSessionIds: string[]
 * 控制台直接读会话日志，所以必须自己尊重这个状态，否则「归档之后还能看到」。
 *
 * 设计：
 *  - 默认路径从 sessionsRoot 推导：<sessionsRoot 的父目录>/storages/workspace.json；
 *  - 可用 options.archiveFile 显式覆盖；
 *  - 文件不存在 / JSON 损坏 / 结构不认识 → 返回空集合（fail-open，不影响正常浏览）；
 *  - 按 (file, mtime) + 2s 短 TTL 缓存，避免 2.5s 轮询反复读盘。
 */
import fs from "node:fs";
import path from "node:path";
import { defaultSessionsRoot } from "./sessions.js";

const CACHE_TTL_MS = 2000;
const CACHE_MAX_FILES = 8;
/** file -> { mtimeMs: number, at: number, ids: Set<string> } */
const cacheMap = new Map();

/** 默认归档状态文件：<sessionsRoot>/../storages/workspace.json */
export function defaultArchiveFile(sessionsRoot) {
  const root = sessionsRoot || defaultSessionsRoot();
  return path.join(path.dirname(path.resolve(root)), "storages", "workspace.json");
}

/** 显式配置优先，否则按约定推导。 */
export function resolveArchiveFile(sessionsRoot, explicit) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return defaultArchiveFile(sessionsRoot);
}

function setCache(file, entry) {
  cacheMap.delete(file);
  cacheMap.set(file, entry);
  if (cacheMap.size > CACHE_MAX_FILES) {
    const oldest = cacheMap.keys().next().value;
    if (oldest !== undefined) cacheMap.delete(oldest);
  }
}

/**
 * 读取已归档会话 id 集合（同时收录带 / 不带 "session-" 前缀两种写法，
 * 因为根会话目录名带前缀、子会话目录名不带）。
 * @returns {Set<string>}
 */
export function readArchivedSessionIds(options) {
  const opts = options || {};
  const file = resolveArchiveFile(opts.sessionsRoot, opts.archiveFile);
  const now = Date.now();
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    const empty = new Set();
    setCache(file, { mtimeMs: -1, at: now, ids: empty });
    return empty;
  }
  const cached = cacheMap.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && now - cached.at < CACHE_TTL_MS) {
    return cached.ids;
  }
  const ids = new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = parsed && parsed.global && Array.isArray(parsed.global.archivedSessionIds)
      ? parsed.global.archivedSessionIds
      : [];
    for (const raw of list) {
      if (typeof raw !== "string" || !raw) continue;
      ids.add(raw);
      if (raw.indexOf("session-") === 0) ids.add(raw.slice("session-".length));
      else ids.add("session-" + raw);
    }
  } catch {
    /* 坏文件按"没有归档"处理，宁可多显示也不要把整面板清空 */
  }
  setCache(file, { mtimeMs: stat.mtimeMs, at: now, ids });
  return ids;
}

/** 某个会话是否已归档。 */
export function isArchivedSession(sessionId, options) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const ids = readArchivedSessionIds(options);
  return ids.has(sessionId) || ids.has("session-" + sessionId);
}
