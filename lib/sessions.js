/**
 * dsh-team-console — 会话日志读取层（v3：Zstd 结构化切帧 + 半帧保护 + 双格式增量解码 + 限容缓存）。
 *
 * DSH 把每个会话持久化为 <sessions>/<workspace>/<sessionId>/session.v4.jsonl.zstd：
 * 一个追加写的 zstd 文件，每次追加写一个新的独立 zstd frame（不是单个流），
 * 内部是 JSONL 事件流；测试与 demo 也会使用未压缩的 session.v4.jsonl。
 *
 * 设计要点：
 *  - 优先按 Zstd RFC 8878 帧头/块头结构精确切帧，识别尚未刷盘完毕的半帧（tornStart）；
 *    结构扫描遇异常时回退到魔数合并重试（最多合并 8 段），避免压缩体里的 0x28B52FFD 误切。
 *  - 增量解码同时支持 .jsonl.zstd 与纯文本 .jsonl：只解码上次已消费偏移之后的新增字节；
 *    若有半帧留在末尾，consumed 停在半帧起点之前，下次轮询会自动重试。
 *  - 缓存按文件路径 LRU + 源字节预算（默认 12MB / 12 文件），不会随历史增长无限占内存。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const ZSTD_MAGIC_U32 = 0xfd2fb528;
const LOG_NAMES = ["session.v4.jsonl.zstd", "session.v4.jsonl"];
const CACHE_BYTE_BUDGET = 12 * 1024 * 1024;
const CACHE_MAX_FILES = 12;
const HEADER_CHUNK_BYTES = 64 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) return false;
  return SESSION_ID_RE.test(sessionId) && sessionId.indexOf("..") === -1;
}

export function defaultSessionsRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (!home) throw new Error("无法确定用户主目录：请显式配置 sessionsRoot");
  return path.join(home, ".dsh", "sessions");
}

function hasZstd() {
  return typeof zlib.zstdDecompressSync === "function";
}

function isZstdBuffer(raw, offset = 0) {
  return Boolean(raw && raw.length - offset >= 4 && raw.readUInt32LE(offset) === ZSTD_MAGIC_U32);
}

/** 尝试解压一个完整 zstd frame；失败返回 null。 */
function tryFrame(buffer) {
  if (!hasZstd()) return null;
  try {
    return zlib.zstdDecompressSync(buffer).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 按 Zstandard 帧头/块头结构定位完整帧区间，并在末尾存在未写完的半帧时返回 tornStart。
 * @param {Buffer} buffer
 * @param {number} [startOffset=0]
 * @param {number} [maxFrames=Infinity]
 * @returns {{ frames: Array<{start: number, end: number}>, tornStart?: number }}
 */
function scanZstdFrames(buffer, startOffset = 0, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = startOffset;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC_U32) {
      throw new Error("invalid zstd frame magic at byte " + offset);
    }
    offset += 4;

    if (offset >= buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error("reserved zstd frame-header bit at byte " + (offset - 1));
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error("reserved zstd block type at byte " + (offset - 3));
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }

    frames.push({ start, end: offset });
    if (frames.length >= maxFrames) return { frames };
  }

  return { frames };
}

/**
 * 魔数回退扫描：当结构化扫描因损坏字节抛错时，候选边界解压失败向后合并重试（最多 8 段）。
 */
function decodeMagicFramesFrom(raw, startOffset) {
  const offsets = [];
  let cursor = startOffset;
  while (true) {
    const at = raw.indexOf(ZSTD_MAGIC, cursor);
    if (at === -1) break;
    offsets.push(at);
    cursor = at + 4;
  }
  if (offsets.length === 0) return { text: "", consumed: raw.length, failedFrames: 0 };
  const chunks = [];
  let index = 0;
  let failedFrames = 0;
  while (index < offsets.length) {
    const start = offsets[index];
    let decoded = null;
    let nextIndex = index + 1;
    for (let j = index + 1; j <= Math.min(offsets.length, index + 8); j += 1) {
      const end = j < offsets.length ? offsets[j] : raw.length;
      decoded = tryFrame(raw.subarray(start, end));
      if (decoded !== null) {
        nextIndex = j;
        break;
      }
    }
    if (decoded === null) {
      failedFrames += 1;
      index += 1;
      continue;
    }
    chunks.push(decoded);
    index = nextIndex;
  }
  return { text: chunks.join(""), consumed: raw.length, failedFrames };
}

/**
 * 解码 [startOffset, raw.length) 区间内的所有完整 zstd frame。
 * 优先走结构化帧边界扫描，遇到半帧时保留在末尾不推进 consumed，等待下次追加。
 * @returns {{text: string, consumed: number, failedFrames: number}}
 */
function decodeFramesFrom(raw, startOffset) {
  if (!hasZstd()) throw new Error("当前 Node 运行时不支持 zstd（需要 >= 22.15），无法解析会话日志");
  try {
    const scan = scanZstdFrames(raw, startOffset);
    const chunks = [];
    let failedFrames = 0;
    for (const frame of scan.frames) {
      const decoded = tryFrame(raw.subarray(frame.start, frame.end));
      if (decoded !== null) {
        chunks.push(decoded);
      } else {
        failedFrames += 1;
      }
    }
    const consumed = scan.tornStart !== undefined ? scan.tornStart : raw.length;
    return { text: chunks.join(""), consumed, failedFrames };
  } catch {
    return decodeMagicFramesFrom(raw, startOffset);
  }
}

/** 全量解压（测试/兼容用）。 */
export function decodeLogText(raw) {
  if (!raw || raw.length === 0) return "";
  if (!isZstdBuffer(raw, 0)) return raw.toString("utf8");
  return decodeFramesFrom(raw, 0).text;
}

function parseLines(text) {
  const out = [];
  if (!text) return { events: out, partial: "" };
  const parts = text.split("\n");
  let partial = parts.pop() || "";
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* 单行损坏不影响其它事件 */
    }
  }
  if (partial) {
    const trimmedPartial = partial.trim();
    if (trimmedPartial) {
      try {
        out.push(JSON.parse(trimmedPartial));
        partial = "";
      } catch {
        /* 确为半行，留待下次追加拼接 */
      }
    } else {
      partial = "";
    }
  }
  return { events: out, partial };
}

/** file -> {mtimeMs,size,consumed,isZstd,events,partial,bytes} */
const fileStates = new Map();
let cachedBytes = 0;
let workspaceCache = { at: 0, root: "", dirs: [] };

function evictIfNeeded(protectedFile) {
  let guard = 0;
  while ((cachedBytes > CACHE_BYTE_BUDGET || fileStates.size > CACHE_MAX_FILES) && guard < 256) {
    guard += 1;
    let oldestKey = null;
    for (const [key] of fileStates) {
      if (key === protectedFile) continue;
      oldestKey = key;
      break;
    }
    if (!oldestKey) break;
    const old = fileStates.get(oldestKey);
    cachedBytes -= old.bytes || 0;
    fileStates.delete(oldestKey);
  }
}

function workspaceDirs(sessionsRoot) {
  const fresh = Date.now() - workspaceCache.at < 5000 && workspaceCache.root === sessionsRoot;
  if (fresh) return workspaceCache.dirs;
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(sessionsRoot, d.name));
  } catch {
    dirs = [];
  }
  workspaceCache = { at: Date.now(), root: sessionsRoot, dirs };
  return dirs;
}

/** 目录名规则：根会话 session-<id>，子会话就是 <id>。 */
function sessionDirNames(sessionId) {
  return sessionId.startsWith("session-") ? [sessionId] : [sessionId, "session-" + sessionId];
}

/** 在所有 workspace 下定位会话文件，返回绝对路径或 null。 */
export function resolveSessionFile(sessionsRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  const names = sessionDirNames(sessionId);
  const root = path.resolve(sessionsRoot);
  for (const ws of workspaceDirs(sessionsRoot)) {
    for (const name of names) {
      for (const fileName of LOG_NAMES) {
        const candidate = path.resolve(path.join(ws, name, fileName));
        if (candidate.indexOf(root + path.sep) !== 0) continue;
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * 读取并解析一个会话文件的事件数组。
 * 追加写场景只解码上次已消费偏移之后的新增字节；结果按 (file, mtime, size) 缓存。
 */
export function readSessionEvents(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const cached = fileStates.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    fileStates.delete(file);
    fileStates.set(file, cached);
    return cached.events;
  }

  let state = cached;
  if (!state) {
    state = { mtimeMs: 0, size: 0, consumed: 0, isZstd: false, events: [], partial: "", bytes: 0 };
  }

  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return state.events;
  }

  const fileIsZstd = isZstdBuffer(raw, 0);

  try {
    const resumeOffset = typeof state.consumed === "number" && state.consumed > 0 ? state.consumed : state.size;
    if (state.size > 0 && raw.length >= state.size && resumeOffset <= raw.length && state.isZstd === fileIsZstd) {
      if (resumeOffset === raw.length) {
        // 文件元信息变了但没有新增字节
      } else if (!fileIsZstd) {
        const tailText = raw.subarray(resumeOffset).toString("utf8");
        const parsed = parseLines((state.partial || "") + tailText);
        if (parsed.events.length > 0) state.events = state.events.concat(parsed.events);
        state.partial = parsed.partial;
        state.consumed = raw.length;
      } else if (isZstdBuffer(raw, resumeOffset)) {
        const tail = decodeFramesFrom(raw, resumeOffset);
        const parsed = parseLines((state.partial || "") + tail.text);
        if (parsed.events.length > 0) state.events = state.events.concat(parsed.events);
        state.partial = parsed.partial;
        state.consumed = tail.consumed;
      } else {
        // 追加点不是 frame 起点（例如被重写），退回全量解码
        const full = decodeFramesFrom(raw, 0);
        const parsed = parseLines(full.text);
        state.events = parsed.events;
        state.partial = parsed.partial;
        state.consumed = full.consumed;
      }
    } else if (!fileIsZstd) {
      const text = raw.toString("utf8");
      const parsed = parseLines(text);
      state.events = parsed.events;
      state.partial = parsed.partial;
      state.consumed = raw.length;
    } else {
      const full = decodeFramesFrom(raw, 0);
      const parsed = parseLines(full.text);
      state.events = parsed.events;
      state.partial = parsed.partial;
      state.consumed = full.consumed;
    }
    state.isZstd = fileIsZstd;
  } catch (error) {
    if (!state.events.length) throw error;
  }

  state.mtimeMs = stat.mtimeMs;
  state.size = raw.length;
  state.bytes = raw.length;
  cachedBytes += raw.length - (cached ? cached.bytes || 0 : 0);
  fileStates.delete(file);
  fileStates.set(file, state);
  evictIfNeeded(file);
  return state.events;
}

/** 列出所有 workspace 下的会话目录，附带文件 stat。 */
export function listSessionDirs(sessionsRoot) {
  const out = [];
  for (const ws of workspaceDirs(sessionsRoot)) {
    let entries = [];
    try {
      entries = fs.readdirSync(ws, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const fileName of LOG_NAMES) {
        const file = path.join(ws, entry.name, fileName);
        try {
          const stat = fs.statSync(file);
          out.push({
            file,
            dirName: entry.name,
            workspace: path.basename(ws),
            workspacePath: ws,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          });
          break;
        } catch {
          /* not a session */
        }
      }
    }
  }
  return out;
}

/**
 * 轻量摘要读取：只解析判断团队所需的少量行（session / team / title），
 * 其余行只做字符串预筛，避免把整份大日志解析成对象常驻内存。
 * 遵循 DSH teamId 隔离语义：若会话存在 header.id，则忽略继承自其他 teamId 的 team/* 事件。
 * @returns {{header: any, title: string, isLead: boolean, members: any[], tasks: any[]}}
 */
export function readSessionSummary(file) {
  let text = "";
  try {
    text = decodeLogText(fs.readFileSync(file));
  } catch {
    return { header: null, title: "", isLead: false, members: [], tasks: [] };
  }
  const members = new Map();
  const tasks = new Map();
  let header = null;
  let title = "";
  let fallbackTitle = "";
  let isLead = false;
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!header && line.indexOf('"type":"session"') !== -1) {
      try {
        const candidate = JSON.parse(line);
        if (candidate && candidate.type === "session") {
          header = candidate;
          continue;
        }
      } catch {
        /* ignore */
      }
    }
    if (line.indexOf('"type":"team/') !== -1) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const data = event.data || {};
      if (header && header.id && data.teamId && data.teamId !== header.id) {
        continue;
      }
      isLead = true;
      if (event.type === "team/member" && data.member && data.member.id) {
        const previous = members.get(data.member.id) || {};
        members.set(data.member.id, Object.assign({}, previous, data.member));
      }
      if (event.type === "team/task" && data.task && data.task.id) {
        const previous = tasks.get(data.task.id) || {};
        tasks.set(data.task.id, Object.assign({}, previous, data.task));
      }
      continue;
    }
    if (line.indexOf('"type":"session/title"') !== -1) {
      try {
        const event = JSON.parse(line);
        if (event.data && typeof event.data.title === "string") title = event.data.title;
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!title && !fallbackTitle && line.indexOf('"type":"user/message"') !== -1) {
      try {
        const event = JSON.parse(line);
        if (event.type === "user/message" && event.data) {
          const srcKind = event.data.source && event.data.source.kind;
          if (!srcKind || srcKind === "user" || srcKind === "team-message") {
            const content = event.data.content;
            const rawText = typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("")
                : "";
            const trimmed = rawText.trim();
            if (
              trimmed &&
              !trimmed.startsWith("Current runtime context") &&
              !trimmed.startsWith("<system-reminder>") &&
              !trimmed.startsWith("<available_skills>") &&
              !/^Time sampled while preparing/.test(trimmed) &&
              !/^Agent Teams is available/.test(trimmed)
            ) {
              const first = trimmed.split("\n")[0];
              fallbackTitle = first.length > 80 ? first.slice(0, 80) + "…" : first;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { header, title: title || fallbackTitle, isLead, members: [...members.values()], tasks: [...tasks.values()] };
}

/** 会话头缓存：file -> {mtimeMs,size,header} */
const headerCache = new Map();

function readFirstChunk(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function parseFirstHeaderFromChunk(buf) {
  if (isZstdBuffer(buf, 0)) {
    try {
      const scan = scanZstdFrames(buf, 0, 1);
      if (scan.frames.length > 0) {
        const f = scan.frames[0];
        const text = tryFrame(buf.subarray(f.start, f.end));
        if (text !== null) {
          const firstLine = text.split("\n")[0];
          return JSON.parse(firstLine);
        }
      }
    } catch {
      /* fallback below */
    }
    // Fallback: magic scan on first frame
    let cursor = 4;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = buf.indexOf(ZSTD_MAGIC, cursor);
      const end = next === -1 ? buf.length : next;
      const text = tryFrame(buf.subarray(0, end));
      if (text !== null) {
        const firstLine = text.split("\n")[0];
        return JSON.parse(firstLine);
      }
      if (next === -1) break;
      cursor = next + 4;
    }
    return null;
  }
  const text = buf.toString("utf8");
  const nl = text.indexOf("\n");
  if (nl === -1 && buf.length >= HEADER_CHUNK_BYTES) return null;
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  return JSON.parse(firstLine);
}

/**
 * 只读会话头（id / parentSession / cwd / createdAt），只读前 64KB 并解压第一个 zstd frame。
 * 用于在没有 team/* 事件时，仍能从"子会话的 parentSession"还原团队结构。
 */
export function readSessionHeader(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = headerCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.header;
  let header = null;
  try {
    const chunk = readFirstChunk(file, HEADER_CHUNK_BYTES);
    header = parseFirstHeaderFromChunk(chunk);
    if (!header && stat.size > HEADER_CHUNK_BYTES) {
      const full = fs.readFileSync(file);
      header = parseFirstHeaderFromChunk(full);
    }
  } catch {
    header = null;
  }
  headerCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, header });
  if (headerCache.size > 400) {
    for (const key of headerCache.keys()) {
      headerCache.delete(key);
      if (headerCache.size <= 300) break;
    }
  }
  return header;
}

/** 列出所有会话的头（含 parentSession），用于按"子会话"还原团队。 */
export function listSessionHeaders(sessionsRoot) {
  const out = [];
  for (const entry of listSessionDirs(sessionsRoot)) {
    const header = readSessionHeader(entry.file);
    if (!header || !header.id) continue;
    out.push({
      id: header.id,
      parentSession: header.parentSession || null,
      cwd: header.cwd || "",
      createdAt: header.createdAt || 0,
      file: entry.file,
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      workspace: entry.workspace,
    });
  }
  return out;
}
