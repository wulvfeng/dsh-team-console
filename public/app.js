/* dsh-team-console — 独立网页版（与 DSH 面板同一套设计）。 */
(function () {
  var API_PORTS = [];
  for (var p = 4318; p < 4338; p += 1) API_PORTS.push(p);
  var POLL_MS = 2500;
  /* B3：数据请求超时；同时保证同一时刻只有一轮拉取（见 tick 的 inFlight 守卫）。 */
  var DATA_TIMEOUT_MS = 8000;
  var requestSeq = 0;
  var inFlight = false;
  var rerunPending = false;
  /* 允许用 ?api=4320 或 ?api=http://127.0.0.1:4320 指定数据服务（示例演示 / 多实例排查用）。 */
  var API_OVERRIDE = (function () {
    var match = /[?&]api=([^&]+)/.exec(location.search || "");
    if (!match) return null;
    var value = decodeURIComponent(match[1]);
    if (/^\d+$/.test(value)) return "http://" + location.hostname + ":" + value;
    if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
    return null;
  })();
  var state = {
    api: null, teams: [], leadId: null, team: null, selected: null, transcript: null,
    updatedAt: 0, error: null, stick: true, openTurns: {}, expandedTask: null, lastCount: undefined,
    showMissionPrompt: false, lastSelected: null
  };

  var el = function (id) { return document.getElementById(id); };
  function setHtml(node, html) {
    if (!node) return false;
    if (node.__lastHtml === html) return false;
    node.__lastHtml = html;
    node.innerHTML = html;
    return true;
  }
  var nodes = {
    teamSelect: el("teamSelect"), liveDot: el("liveDot"), liveText: el("liveText"), clock: el("clock"),
    overviewNavBtn: el("overviewNavBtn"), overviewSub: el("overviewSub"),
    reqCount: el("reqCount"), tree: el("tree"), streamKind: el("streamKind"), streamTitle: el("streamTitle"),
    streamMeta: el("streamMeta"), context: el("context"), sectBar: el("sectBar"), feed: el("feed"), jumpBtn: el("jumpBtn")
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/\'/g, "&#39;");
  }

  /* >>> md-parser —— 两端逐字一致：这里的每个字符都必须与另一端的同名区块相同
     1) mdEsc() 先整体转义，2) 再解析：原始 HTML 因此只可能以文本出现；
     产物是与序列化无关的 token 树（块级 t / 行内 k），token 内字符串一律是「已转义」文本，
     HTML 端直接拼接，React 端用 mdUnesc() 还原成真实文本。 */
  var MD_MAX_INLINE = 4;
  var MD_MAX_QUOTE = 3;
  var MD_INLINE_STEPS = 12000;
  var MD_LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
  var MD_FENCE_RE = /^(`{3,})([^`]*)$/;
  var MD_HEADING_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
  var MD_QUOTE_RE = /^(?:&gt;|>)[ \t]?(.*)$/;
  var MD_HR_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
  var MD_TABLE_SEP_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  var MD_ESCAPABLE = "\\`*_{}[]()#+-.!>~|";

  function mdEsc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* 链接协议白名单：http / https / mailto / 站内相对路径（/ 开头，排除 // 与 /\） */
  function mdSafeHref(value) {
    var url = String(value == null ? "" : value).trim();
    if (!url || /[\s\u0000-\u001f]/.test(url)) return "";
    if (/&quot;|&#39;|&lt;|&gt;/.test(url)) return "";   // URL 里的引号 / 尖括号一律不信任
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
    if (url.charAt(0) === "/" && url.charAt(1) !== "/" && url.charAt(1) !== "\\") return url;
    return "";
  }

  /* 找同行内的闭合标记：跨行不闭合、闭合前不留空格 */
  function mdFindClose(text, from, marker) {
    var at = text.indexOf(marker, from);
    while (at !== -1) {
      if (text.slice(from, at).indexOf("\n") !== -1) return -1;
      var before = text.charAt(at - 1);
      if (before !== " " && before !== "\t") return at;
      at = text.indexOf(marker, at + marker.length);
    }
    return -1;
  }

  function mdInline(text, depth) {
    var out = [];
    var buf = "";
    var i = 0;
    var n = text.length;
    var lineStart = true;
    var steps = 0;
    function push(token) {
      if (buf) { out.push({ k: "text", v: buf }); buf = ""; }
      out.push(token);
    }
    while (i < n) {
      steps += 1;
      if (steps > MD_INLINE_STEPS) { buf += text.slice(i); break; }
      var ch = text.charAt(i);
      var next = text.charAt(i + 1);
      if (ch === "\n") { push({ k: "br" }); i += 1; lineStart = true; continue; }
      if (lineStart && ch === "✓") {
        push({ k: "pass" });
        i += 1;
        while (i < n && (text.charAt(i) === " " || text.charAt(i) === "\t")) i += 1;
        lineStart = false;
        continue;
      }
      lineStart = false;
      if (ch === "\\" && next && MD_ESCAPABLE.indexOf(next) !== -1) { buf += next; i += 2; continue; }
      if (ch === "`") {
        var codeEnd = text.indexOf("`", i + 1);
        if (codeEnd > i + 1 && text.slice(i + 1, codeEnd).indexOf("\n") === -1) {
          push({ k: "code", v: text.slice(i + 1, codeEnd) });
          i = codeEnd + 1;
          continue;
        }
      }
      if (depth < MD_MAX_INLINE) {
        if (ch === "*" && next === "*") {
          var boldEnd = mdFindClose(text, i + 2, "**");
          if (boldEnd > i + 2) { push({ k: "b", c: mdInline(text.slice(i + 2, boldEnd), depth + 1) }); i = boldEnd + 2; continue; }
        }
        if (ch === "_" && next === "_") {
          /* __bold__：两侧不吞词内下划线（左 __ 前不能是字母数字、右 __ 后不能是字母数字） */
          var strongEnd = mdFindClose(text, i + 2, "__");
          if (strongEnd > i + 2 && !/[0-9A-Za-z\u4e00-\u9fff\u3040-\u30ff]/.test(text.charAt(i - 1)) && !/[0-9A-Za-z\u4e00-\u9fff\u3040-\u30ff]/.test(text.charAt(strongEnd + 2))) {
            push({ k: "b", c: mdInline(text.slice(i + 2, strongEnd), depth + 1) });
            i = strongEnd + 2;
            continue;
          }
          buf += "__";   /* 词内 / 不成立的双下划线原样保留，避免被拆成单下划线斜体 */
          i += 2;
          continue;
        }
        if (ch === "~" && next === "~") {
          var delEnd = mdFindClose(text, i + 2, "~~");
          if (delEnd > i + 2) { push({ k: "del", c: mdInline(text.slice(i + 2, delEnd), depth + 1) }); i = delEnd + 2; continue; }
        }
        if (ch === "*" && next && next !== " " && next !== "\t" && next !== "*") {
          var emEnd = mdFindClose(text, i + 1, "*");
          if (emEnd > i + 1) { push({ k: "i", c: mdInline(text.slice(i + 1, emEnd), depth + 1) }); i = emEnd + 1; continue; }
        }
        if (ch === "_" && next && next !== " " && next !== "\t" && next !== "_" && !/[0-9A-Za-z\u4e00-\u9fff\u3040-\u30ff]/.test(text.charAt(i - 1))) {
          var undEnd = mdFindClose(text, i + 1, "_");
          if (undEnd > i + 1 && !/[0-9A-Za-z\u4e00-\u9fff\u3040-\u30ff]/.test(text.charAt(undEnd + 1))) {
            push({ k: "i", c: mdInline(text.slice(i + 1, undEnd), depth + 1) });
            i = undEnd + 1;
            continue;
          }
        }
        if (ch === "[") {
          var labelEnd = text.indexOf("]", i + 1);
          if (labelEnd > i + 1 && text.charAt(labelEnd + 1) === "(") {
            var urlEnd = text.indexOf(")", labelEnd + 2);
            if (urlEnd > labelEnd + 2) {
              var label = text.slice(i + 1, labelEnd);
              var url = text.slice(labelEnd + 2, urlEnd);
              if (label.indexOf("\n") === -1 && url.indexOf("\n") === -1 && url.indexOf(" ") === -1 && url.indexOf("\t") === -1) {
                var href = mdSafeHref(url);
                if (href) { push({ k: "a", href: href, c: mdInline(label, depth + 1) }); i = urlEnd + 1; continue; }
                buf += text.slice(i, urlEnd + 1);
                i = urlEnd + 1;
                continue;
              }
            }
          }
        }
      }
      buf += ch;
      i += 1;
    }
    if (buf) out.push({ k: "text", v: buf });
    return out;
  }

  function mdTableSplit(line) {
    var text = String(line == null ? "" : line).trim();
    if (text.charAt(0) === "|") text = text.slice(1);
    if (text.charAt(text.length - 1) === "|" && text.charAt(text.length - 2) !== "\\") text = text.slice(0, -1);
    var cells = [];
    var buf = "";
    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch === "\\" && text.charAt(i + 1) === "|") { buf += "|"; i += 2; continue; }
      if (ch === "|") { cells.push(buf); buf = ""; i += 1; continue; }
      buf += ch;
      i += 1;
    }
    cells.push(buf);
    return cells.map(function (cell) { return cell.trim(); });
  }

  function mdTableDelim(line) {
    if (!line || line.indexOf("|") === -1 || line.indexOf("-") === -1) return false;
    return MD_TABLE_SEP_RE.test(line);
  }

  function mdTableAt(lines, i) {
    if (String(lines[i] == null ? "" : lines[i]).indexOf("|") === -1) return null;
    if (i + 1 >= lines.length || !mdTableDelim(lines[i + 1])) return null;
    var head = mdTableSplit(lines[i]);
    var width = head.length;
    if (width === 0) return null;
    var rows = [];
    var j = i + 2;
    while (j < lines.length) {
      var row = String(lines[j] == null ? "" : lines[j]);
      if (!row.trim() || row.indexOf("|") === -1) break;
      var cells = mdTableSplit(row);
      var nextRow = [];
      for (var c = 0; c < width; c += 1) nextRow.push(mdInline(cells[c] || "", 0));
      rows.push(nextRow);
      j += 1;
    }
    return {
      block: { t: "table", head: head.map(function (cell) { return mdInline(cell, 0); }), rows: rows },
      next: j
    };
  }

  function mdListTree(items) {
    var roots = [];
    var last = [];
    items.forEach(function (item) {
      var level = item.level;
      if (level > last.length) level = last.length;
      var node = { inl: item.inl, kids: [] };
      if (level <= 0) { roots.push(node); last = [node]; return; }
      last[level - 1].kids.push(node);
      last = last.slice(0, level);
      last.push(node);
    });
    return roots;
  }

  function mdListAt(lines, i) {
    var first = MD_LIST_RE.exec(lines[i]);
    var base = first[1].length;
    var ordered = /\d/.test(first[2].charAt(0));
    var items = [];
    var j = i;
    while (j < lines.length) {
      var line = String(lines[j] == null ? "" : lines[j]);
      if (!line.trim()) {
        var after = j + 1;
        var nextItem = after < lines.length ? MD_LIST_RE.exec(lines[after]) : null;
        if (nextItem && nextItem[1].length >= base) { j = after; continue; }
        break;
      }
      var match = MD_LIST_RE.exec(line);
      if (!match) {
        if (items.length && /^[ \t]{2,}/.test(line)) {
          items[items.length - 1].text += "\n" + line.replace(/^[ \t]+/, "");
          j += 1;
          continue;
        }
        break;
      }
      var indent = match[1].length;
      if (indent < base) break;
      if (indent === base && /\d/.test(match[2].charAt(0)) !== ordered) break;
      items.push({ level: indent > base ? Math.max(1, Math.floor((indent - base) / 2)) : 0, text: String(match[3] || ""), inl: null });
      j += 1;
    }
    items.forEach(function (item) { item.inl = mdInline(item.text, 0); });
    return { block: { t: "list", ordered: ordered, tree: mdListTree(items) }, next: j };
  }

  function mdStartsBlock(lines, i) {
    var line = String(lines[i] == null ? "" : lines[i]);
    var body = line.replace(/^[ \t]+/, "");
    if (!body) return true;
    if (MD_FENCE_RE.test(body)) return true;
    if (MD_HR_RE.test(body.replace(/[ \t]+/g, ""))) return true;
    if (MD_HEADING_RE.test(body)) return true;
    if (MD_QUOTE_RE.test(body)) return true;
    if (MD_LIST_RE.test(line)) return true;
    if (i + 1 < lines.length && line.indexOf("|") !== -1 && mdTableDelim(lines[i + 1])) return true;
    return false;
  }

  function mdBlocks(lines, quoteDepth) {
    var blocks = [];
    var i = 0;
    while (i < lines.length) {
      var raw = String(lines[i] == null ? "" : lines[i]);
      var body = raw.replace(/^[ \t]+/, "");
      if (!body) { i += 1; continue; }

      var fence = MD_FENCE_RE.exec(body);
      if (fence) {
        var fenceSize = fence[1].length;
        var lang = String(fence[2] || "").trim().split(/[ \t]+/)[0];
        var codeLines = [];
        i += 1;
        while (i < lines.length) {
          var closeLine = String(lines[i] == null ? "" : lines[i]).replace(/^[ \t]+/, "");
          var close = MD_FENCE_RE.exec(closeLine);
          if (close && close[1].length >= fenceSize && !String(close[2] || "").trim()) { i += 1; break; }
          codeLines.push(String(lines[i] == null ? "" : lines[i]));
          i += 1;
        }
        blocks.push({ t: "code", lang: lang, text: codeLines.join("\n") });
        continue;
      }

      if (MD_HR_RE.test(body.replace(/[ \t]+/g, ""))) { blocks.push({ t: "hr" }); i += 1; continue; }

      var heading = MD_HEADING_RE.exec(body);
      if (heading) {
        var level = heading[1].length;
        if (level > 4) level = 4;
        blocks.push({ t: "h", level: level, inl: mdInline(String(heading[2] || "").trim(), 0) });
        i += 1;
        continue;
      }

      var quote = MD_QUOTE_RE.exec(body);
      if (quote) {
        var quoteLines = [];
        while (i < lines.length) {
          var qm = MD_QUOTE_RE.exec(String(lines[i] == null ? "" : lines[i]).replace(/^[ \t]+/, ""));
          if (!qm) break;
          quoteLines.push(qm[1]);
          i += 1;
        }
        if (quoteDepth < MD_MAX_QUOTE) blocks.push({ t: "quote", blocks: mdBlocks(quoteLines, quoteDepth + 1) });
        else blocks.push({ t: "p", inl: mdInline(quoteLines.join("\n"), 0) });
        continue;
      }

      var table = mdTableAt(lines, i);
      if (table) { blocks.push(table.block); i = table.next; continue; }

      if (MD_LIST_RE.test(raw)) {
        var list = mdListAt(lines, i);
        blocks.push(list.block);
        i = list.next;
        continue;
      }

      var paraLines = [];
      while (i < lines.length) {
        var pl = String(lines[i] == null ? "" : lines[i]);
        if (!pl.trim()) break;
        if (paraLines.length > 0 && mdStartsBlock(lines, i)) break;
        paraLines.push(pl.replace(/^[ \t]+/, ""));
        i += 1;
      }
      blocks.push({ t: "p", inl: mdInline(paraLines.join("\n"), 0) });
    }
    return blocks;
  }

  function mdParse(raw) {
    var text = mdEsc(raw);
    try {
      if (!text.trim()) return [];
      return mdBlocks(text.split(/\r\n?|\n/), 0);
    } catch (error) {
      return [{ t: "p", inl: [{ k: "text", v: text }] }];
    }
  }
  /* <<< md-parser */

  /* >>> md-html —— 独立网页端序列化：token 树 → HTML 字符串（token 已转义，直接拼） */
  function mdInlineHtml(tokens) {
    return tokens.map(function (tk) {
      if (tk.k === "text") return tk.v;
      if (tk.k === "br") return "<br>";
      if (tk.k === "pass") return '<span class="dtc-passMark">✓</span> ';
      if (tk.k === "code") return '<code class="dtc-inlineCode">' + tk.v + "</code>";
      if (tk.k === "b") return "<b>" + mdInlineHtml(tk.c) + "</b>";
      if (tk.k === "i") return "<i>" + mdInlineHtml(tk.c) + "</i>";
      if (tk.k === "del") return "<del>" + mdInlineHtml(tk.c) + "</del>";
      if (tk.k === "a") return '<a href="' + tk.href + '" target="_blank" rel="noopener noreferrer">' + mdInlineHtml(tk.c) + "</a>";
      return "";
    }).join("");
  }

  function mdListHtml(block) {
    var tag = block.ordered ? "ol" : "ul";
    return "<" + tag + ">" + block.tree.map(function (node) {
      var kids = node.kids.length ? mdListHtml({ ordered: block.ordered, tree: node.kids }) : "";
      return "<li>" + mdInlineHtml(node.inl) + kids + "</li>";
    }).join("") + "</" + tag + ">";
  }

  function mdBlocksHtml(blocks) {
    return blocks.map(function (b) {
      if (b.t === "p") return "<p>" + mdInlineHtml(b.inl) + "</p>";
      if (b.t === "h") return "<h" + b.level + ">" + mdInlineHtml(b.inl) + "</h" + b.level + ">";
      if (b.t === "hr") return "<hr>";
      if (b.t === "quote") return "<blockquote>" + mdBlocksHtml(b.blocks) + "</blockquote>";
      if (b.t === "list") return mdListHtml(b);
      if (b.t === "code") return '<pre class="dtc-codeBlock"><code' + (b.lang ? ' class="language-' + b.lang + '"' : "") + ">" + b.text + "</code></pre>";
      if (b.t === "table") {
        var head = "<thead><tr>" + b.head.map(function (cell) {
          return "<th>" + mdInlineHtml(cell) + "</th>";
        }).join("") + "</tr></thead>";
        var body = "<tbody>" + b.rows.map(function (row) {
          return "<tr>" + row.map(function (cell) { return "<td>" + mdInlineHtml(cell) + "</td>"; }).join("") + "</tr>";
        }).join("") + "</tbody>";
        return '<div class="dtc-mdScroll"><table>' + head + body + "</table></div>";
      }
      return "";
    }).join("");
  }

  function formatRichText(raw) {
    return mdBlocksHtml(mdParse(raw));
  }
  /* <<< md-html */

  function ago(ms) {
    if (!ms) return "";
    var delta = Date.now() - ms;
    if (delta < 0) delta = 0;
    if (delta < 3000) return "刚刚";
    if (delta < 60000) return Math.floor(delta / 1000) + " 秒前";
    if (delta < 3600000) return Math.floor(delta / 60000) + " 分钟前";
    if (delta < 86400000) return Math.floor(delta / 3600000) + " 小时前";
    return Math.floor(delta / 86400000) + " 天前";
  }

  function clock(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function initials(name) {
    var text = String(name || "?").trim();
    if (!text) return "?";
    if (/^[\u4e00-\u9fa5]/.test(text)) return text.charAt(0);
    var parts = text.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ").filter(Boolean);
    if (parts.length === 0) return (Array.from(text)[0] || "?").toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function avatarStyle(name) {
    var hash = 0;
    var text = String(name || "?");
    for (var i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    return "background:linear-gradient(135deg,hsl(" + hash + " 62% 46%),hsl(" + ((hash + 36) % 360) + " 58% 38%))";
  }

  function phaseLabel(phase) {
    if (phase === "active") return "活跃";
    if (phase === "provisioning") return "准备中";
    if (phase === "failed") return "失败";
    if (phase === "inactive") return "空闲";
    return phase || "";
  }

  function memberDot(member) {
    var activity = member.activity || {};
    if (member.phase === "failed") return "bad";
    if (activity.kind === "tool" || activity.kind === "thinking") return "ok busy";
    if (member.phase === "provisioning") return "warn busy";
    return "";
  }

  function taskState(task) {
    if (task.status === "completed") return { dot: "ok", badge: "已完成", cls: "ok" };
    if (task.status === "in_progress") return { dot: "ok busy", badge: "进行中", cls: "" };
    if (task.blocked) return { dot: "warn", badge: "被阻塞", cls: "warn" };
    return { dot: "", badge: "可开始", cls: "" };
  }

  function duration(item) {
    if (!item || !item.time || !item.resultTime) return "";
    var ms = item.resultTime - item.time;
    if (ms < 0) return "";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(1) + "s";
  }

  /* >>> step-title helpers：把工具调用说成人话（动作 + 目标） */
  var STEP_VERBS = {
    write: "写文件",
    read: "读文件",
    read_image: "查看图片",
    edit: "修改文件",
    pwsh: "运行命令",
    bash: "运行命令",
    glob: "查找文件",
    grep: "搜索内容",
    run_code: "执行脚本",
    web_fetch: "抓取网页",
    web_search: "搜索网页",
    subagent: "委派子代理",
    subagent_fork: "分叉子代理",
    spawn_teammate: "创建成员",
    team_task_create: "创建任务",
    team_task_update: "更新任务",
    team_task_list: "查看任务板",
    team_task_get: "查看任务",
    list_agents: "查看成员",
    wait_agent: "等待成员",
    interrupt_agent: "中断成员",
    todo_write: "更新待办",
    skill: "加载技能",
    present: "交付文件",
    job_output: "读取后台任务",
    job_list: "列出后台任务",
    job_kill: "终止后台任务",
    lsp: "代码诊断"
  };

  function oneLine(value, max) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (max) {
      var points = Array.from(text);
      if (points.length > max) text = points.slice(0, max - 1).join("") + "…";
    }
    return text;
  }

  function shortPath(value) {
    var text = oneLine(value, 0);
    if (!text) return "";
    if (Array.from(text).length <= 58) return text;
    var sep = text.indexOf("\\") !== -1 ? "\\" : "/";
    var drive = /^[A-Za-z]:/.test(text) ? text.slice(0, 2) : "";
    var parts = text.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 2) return oneLine(text, 58);
    var tail = parts.slice(-2).join(sep);
    return (drive || "") + sep + "…" + sep + tail;
  }

  function stepArgs(step) {
    var raw = step && step.args;
    if (!raw || typeof raw !== "string") return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function describeStep(step) {
    var name = String((step && (step.name || step.toolName)) || "").trim();
    var args = stepArgs(step) || {};
    var headline = oneLine(step && step.headline, 80);
    var full = "";
    var verb = STEP_VERBS[name] || "";
    if (name === "send_message") {
      full = oneLine(args.agent || args.target || headline, 0) || "成员";
      return { tool: name, verb: "发消息给", target: oneLine(full, 40), title: "发消息给 " + oneLine(full, 40), detail: name, full: "发消息给 " + full };
    }
    if (verb) {
      if (name === "write" || name === "read" || name === "read_image" || name === "edit") {
        full = oneLine(args.file_path || args.path, 0) || headline;
        return { tool: name, verb: verb, target: shortPath(full), title: verb + (full ? " · " + shortPath(full) : ""), detail: name, full: verb + (full ? " · " + full : "") };
      }
      if (name === "pwsh" || name === "bash") {
        full = oneLine(String(args.command || "").split("\n")[0], 0) || headline;
        return { tool: name, verb: verb, target: oneLine(full, 72), title: verb + (full ? " · " + oneLine(full, 72) : ""), detail: name, full: verb + (full ? " · " + full : "") };
      }
      if (name === "glob" || name === "grep") {
        full = oneLine(args.pattern, 0) || headline;
        return { tool: name, verb: verb, target: oneLine(full, 72), title: verb + (full ? " · " + oneLine(full, 72) : ""), detail: name, full: verb + (full ? " · " + full : "") };
      }
      if (name === "web_fetch") {
        full = oneLine(args.url, 0) || headline;
        return { tool: name, verb: verb, target: oneLine(full, 72), title: verb + (full ? " · " + oneLine(full, 72) : ""), detail: name, full: verb + (full ? " · " + full : "") };
      }
      full = oneLine(args.description || args.name || args.subject || args.query, 0) || headline || oneLine(String(args.code || "").split("\n")[0], 0);
      return { tool: name, verb: verb, target: oneLine(full, 72), title: verb + (full ? " · " + oneLine(full, 72) : ""), detail: name, full: verb + (full ? " · " + full : "") };
    }
    if (!name) return { tool: "", verb: "", target: headline, title: headline || "执行", detail: "", full: headline };
    return { tool: name, verb: name, target: headline, title: headline ? name + " · " + headline : name, detail: "", full: name + (headline ? " · " + headline : "") };
  }

  function getJson(url, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller && timeoutMs ? setTimeout(function () { try { controller.abort(); } catch (e) {} }, timeoutMs) : null;
    return fetch(url, controller ? { cache: "no-store", signal: controller.signal } : { cache: "no-store" }).then(function (response) {
      if (timer) clearTimeout(timer);
      if (!response.ok) {
        var err = new Error("HTTP " + response.status);
        err.status = response.status;
        throw err;
      }
      return response.json();
    }, function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }

  async function findApi() {
    if (API_OVERRIDE) {
      try {
        var overrideHealth = await getJson(API_OVERRIDE + "/api/health", 700);
        if (overrideHealth && overrideHealth.ok) return API_OVERRIDE;
      } catch (error) { /* 指定的服务不可用时回退到端口探测 */ }
    }
    for (var i = 0; i < API_PORTS.length; i += 1) {
      var base = "http://" + location.hostname + ":" + API_PORTS[i];
      try {
        var data = await getJson(base + "/api/health", 700);
        if (data && data.ok) return base;
      } catch (error) { /* try next */ }
    }
    return null;
  }

  function buildRequests(team) {
    var byId = {};
    team.members.forEach(function (member) { byId[member.id] = member; });
    var list = (team.requests || []).map(function (request) {
      return {
        turn: request.turn,
        title: request.title,
        activeTaskCount: request.activeTaskCount || 0,
        members: request.memberIds.map(function (id) { return byId[id]; }).filter(Boolean),
        tasks: team.tasks.filter(function (task) { return request.taskIds.indexOf(task.id) !== -1; })
      };
    });
    if (list.length === 0) list = [{ turn: 0, title: "全部成员与任务", activeTaskCount: 0, members: team.members, tasks: team.tasks }];
    return list;
  }

  function renderMember(member) {
    var activity = member.activity || {};
    var busy = activity.kind === "tool" || activity.kind === "thinking";
    var line = activity.label || "空闲";
    if (activity.lastTime) line += " · " + ago(activity.lastTime);
    var on = state.selected === member.id ? " is-on" : "";
    return '<button type="button" class="dtc-member' + on + '" data-member="' + esc(member.id) + '">' +
      '<span class="dtc-avatar" style="' + avatarStyle(member.name) + '">' + esc(initials(member.name)) + "</span>" +
      '<span class="dtc-memberBody"><div class="dtc-memberName"><span>' + esc(member.name || member.id) + "</span>" +
        (member.phase ? '<span class="dtc-phase phase-' + esc(member.phase) + '">' + esc(phaseLabel(member.phase)) + "</span>" : "") +
      '</div><div class="dtc-memberActivity' + (busy ? " is-busy" : "") + '">' + esc(line) + "</div></span>" +
      '<span class="dtc-dot ' + memberDot(member) + '"></span></button>';
  }

  function renderTask(task) {
    var st = taskState(task);
    var expanded = state.expandedTask === task.id;
    var detail = "";
    if (expanded) {
      detail = '<div class="dtc-taskDetail">' + esc(task.description || "") +
        (task.blockedBy && task.blockedBy.length ? '<div class="dtc-taskRow">依赖：' + esc(task.blockedBy.join(" · ")) + "</div>" : "") +
        (task.writeScopes && task.writeScopes.length ? '<div class="dtc-taskRow">写入范围：' + esc(task.writeScopes.join(" · ")) + "</div>" : "") +
      "</div>";
    }
    return '<div class="dtc-task" data-task="' + esc(task.id) + '" data-owner="' + esc(task.ownerId || "") + '" title="' + (task.ownerId ? "查看负责人对话" : "展开任务详情") + '">' +
      /* 键盘可达性放 .dtc-taskMain（▾ 按钮的兄弟节点），避免 role="button" 包裹真实 button；点击整行仍由外层委托处理。 */
      '<div class="dtc-taskMain" role="button" tabindex="0"><span class="dtc-dot ' + st.dot + '"></span>' +
        '<span class="dtc-id">' + esc(task.id) + "</span>" +
        '<span class="dtc-taskSubject">' + esc(task.subject || "(无标题)") + "</span></div>" +
      '<div class="dtc-taskSide">' +
        (task.ownerName
          ? '<span class="dtc-ownerPill" title="负责人：' + esc(task.ownerName) + '"><span class="dtc-avatarMini" style="' + avatarStyle(task.ownerName) + '">' + esc(initials(task.ownerName)) + '</span><span>' + esc(task.ownerName) + "</span></span>"
          : '<span class="dtc-ownerPill unowned">未分配</span>') +
        '<span class="dtc-chip ' + st.cls + '">' + st.badge + "</span>" +
        '<button type="button" class="dtc-detailBtn' + (expanded ? " open" : "") + '" data-detail="' + esc(task.id) + '">▾</button></div>' +
      detail +
    "</div>";
  }

  function renderTree() {
    var team = state.team;
    if (!team) {
      setHtml(nodes.tree, "");
      if (nodes.reqCount) nodes.reqCount.textContent = "0";
      if (nodes.overviewSub) nodes.overviewSub.textContent = "暂无团队";
      if (nodes.overviewNavBtn && nodes.overviewNavBtn.classList) nodes.overviewNavBtn.classList.remove("is-on");
      return;
    }
    var requests = buildRequests(team);
    if (nodes.reqCount) nodes.reqCount.textContent = String(requests.length);
    if (nodes.overviewSub) {
      nodes.overviewSub.textContent = (team.members.length + 1) + " 智能体 · " + team.tasks.length + " 任务";
    }
    if (nodes.overviewNavBtn && nodes.overviewNavBtn.classList) {
      if (state.selected === "__overview__") nodes.overviewNavBtn.classList.add("is-on");
      else nodes.overviewNavBtn.classList.remove("is-on");
    }

    var leadAct = (team.lead && team.lead.activity) || {};
    var leadBusy = leadAct.kind === "tool" || leadAct.kind === "thinking";
    var leadLine = leadAct.label || "空闲";
    if (leadAct.lastTime) leadLine += " · " + ago(leadAct.lastTime);
    var leadOn = state.selected === state.leadId ? " is-on" : "";
    var leadHtml = '<button type="button" class="dtc-member' + leadOn + '" data-member="' + esc(state.leadId) + '" title="' + esc(team.title || state.leadId) + '">' +
      '<span class="dtc-avatar" style="background:linear-gradient(135deg,#4f46e5,#7c3aed)">主</span>' +
      '<span class="dtc-memberBody"><div class="dtc-memberName"><span>Lead 主控</span><span class="dtc-memberRoleTag">主控</span></div>' +
      '<div class="dtc-memberActivity' + (leadBusy ? " is-busy" : "") + '">' + esc(leadLine) + '</div></span>' +
      '<span class="dtc-dot ' + (leadBusy ? "ok busy" : "") + '"></span></button>';

    var fleetSection = '<div class="dtc-railSection">' +
      '<div class="dtc-railHead"><span>协同智能体</span><b>' + (team.members.length + 1) + '</b></div>' +
      leadHtml +
      team.members.map(renderMember).join("") +
    '</div>';

    var requestsSection = '<div class="dtc-railSection">' +
      '<div class="dtc-railHead"><span>请求与任务</span><b>' + requests.length + '</b></div>' +
      requests.map(function (request, index) {
        var open = state.openTurns[request.turn] !== undefined ? state.openTurns[request.turn] : index === requests.length - 1;
        var done = request.tasks.filter(function (t) { return t.status === "completed"; }).length;
        var progress = request.tasks.length > 0 ? Math.round((done / request.tasks.length) * 100) : 0;
        var displayMembers = request.members.slice();
        if (displayMembers.length === 0 && request.tasks.length > 0) {
          var seenOwner = {};
          request.tasks.forEach(function (task) {
            if (task.ownerName && !seenOwner[task.ownerName]) {
              seenOwner[task.ownerName] = true;
              displayMembers.push({ id: task.ownerId || task.ownerName, name: task.ownerName });
            }
          });
        }
        var avatars = displayMembers.slice(0, 4).map(function (member) {
          return '<span class="dtc-avatarMini" style="' + avatarStyle(member.name) + '" title="' + esc(member.name) + '">' + esc(initials(member.name)) + "</span>";
        }).join("");
        var head = '<button type="button" class="dtc-reqHead" data-req="' + request.turn + '">' +
          '<div class="dtc-reqTop"><span class="dtc-reqIndex">' + (request.turn > 0 ? "第 " + request.turn + " 轮派发" : "未归类") + '</span><span class="dtc-chevron">⌄</span></div>' +
          '<div class="dtc-reqTitle">' + esc(request.title) + "</div>" +
          '<div class="dtc-reqMeta"><span class="dtc-avatars">' + avatars + "</span><span>" + displayMembers.length + " 智能体</span><span>" + request.tasks.length + " 任务</span>" +
          (request.activeTaskCount > 0 ? '<span class="dtc-chip ok">' + request.activeTaskCount + " 进行中</span>" : "") +
          "</div>" +
          (request.tasks.length > 0 ? '<div class="dtc-reqBar"><div class="dtc-reqBarFill" style="width:' + progress + '%"></div></div>' : "") +
        "</button>";
        var children = "";
        if (open) {
          children = '<div class="dtc-children">' + request.tasks.map(renderTask).join("") + "</div>";
        }
        return '<section class="dtc-req' + (open ? " is-open" : "") + '">' + head + children + "</section>";
      }).join("") +
    '</div>';

    setHtml(nodes.tree, fleetSection + requestsSection);
  }

  function renderOverview() {
    var team = state.team;
    if (!team) return "";
    var lead = team.lead || {};
    var members = team.members || [];
    var tasks = team.tasks || [];
    var requests = team.requests || [];

    var totalToolCalls = 0;
    var totalMessages = 0;
    var totalSteps = 0;
    var failedSteps = 0;
    members.forEach(function (m) {
      totalToolCalls += (m.toolCalls || 0);
      totalMessages += (m.messages || 0);
      totalSteps += (m.stepCount || 0);
      failedSteps += (m.failedSteps || 0);
    });
    var successRate = totalSteps > 0 ? Math.round(((totalSteps - failedSteps) / totalSteps) * 100) : 100;
    var completedTasks = tasks.filter(function (t) { return t.status === "completed"; }).length;
    var activeTasks = tasks.filter(function (t) { return t.status === "in_progress"; }).length;

    var heroHtml = '<div class="dtc-cockpitHero">' +
      '<div class="dtc-cockpitBadgeRow">' +
        '<span class="dtc-cockpitTag">◈ DSH Agent Teams 协作指挥中心</span>' +
        '<span class="dtc-cockpitStateTag"><span class="dtc-pulse"></span>智能体协同监控中</span>' +
      '</div>' +
      '<div class="dtc-cockpitTitle">' + esc(team.title || "Agent Teams 协作空间") + '</div>' +
      '<div class="dtc-cockpitMeta">' +
        '<span>📂 工作目录: ' + esc(team.cwd || "本地工作区") + '</span>' +
        '<span>🧠 调度模型: ' + esc(team.model || "默认") + '</span>' +
        '<span>⏱ 启动: ' + ago(team.createdAt) + '</span>' +
        (team.agentPreset ? '<span>🏷 预设模式: ' + esc(team.agentPreset) + '</span>' : '') +
      '</div>' +
    '</div>';

    var metricsHtml = '<div class="dtc-metricsGrid">' +
      '<div class="dtc-metricCard">' +
        '<div class="dtc-metricHead"><span class="dtc-metricLabel">智能体集群</span><span class="dtc-metricIcon">◈</span></div>' +
        '<div class="dtc-metricVal">' + (members.length + 1) + '</div>' +
        '<div class="dtc-metricSub">1 主控 + ' + members.length + ' 协同成员</div>' +
      '</div>' +
      '<div class="dtc-metricCard">' +
        '<div class="dtc-metricHead"><span class="dtc-metricLabel">工具调度总数</span><span class="dtc-metricIcon">⚡</span></div>' +
        '<div class="dtc-metricVal">' + totalToolCalls + '</div>' +
        '<div class="dtc-metricSub">' + totalSteps + ' 步骤 · ' + successRate + '% 成功率</div>' +
      '</div>' +
      '<div class="dtc-metricCard">' +
        '<div class="dtc-metricHead"><span class="dtc-metricLabel">协同任务看板</span><span class="dtc-metricIcon">≡</span></div>' +
        '<div class="dtc-metricVal">' + tasks.length + '</div>' +
        '<div class="dtc-metricSub">' + completedTasks + ' 已完成 · ' + activeTasks + ' 进行中</div>' +
      '</div>' +
      '<div class="dtc-metricCard">' +
        '<div class="dtc-metricHead"><span class="dtc-metricLabel">交互与请求</span><span class="dtc-metricIcon">💬</span></div>' +
        '<div class="dtc-metricVal">' + totalMessages + '</div>' +
        '<div class="dtc-metricSub">' + requests.length + ' 轮次请求派发</div>' +
      '</div>' +
    '</div>';

    var leadBusy = lead.activity && (lead.activity.kind === "tool" || lead.activity.kind === "thinking");
    var leadCard = '<div class="dtc-fleetCard">' +
      '<div class="dtc-fleetCardHead">' +
        '<span class="dtc-avatar" style="background:linear-gradient(135deg,#4f46e5,#7c3aed)">主</span>' +
        '<div class="dtc-fleetNameRow"><div class="dtc-fleetName">' + esc(team.title || "Lead 主控调度") + '</div><span class="dtc-fleetRoleTag lead">Orchestrator 主控调度</span></div>' +
      '</div>' +
      '<div class="dtc-fleetActivity' + (leadBusy ? ' busy' : '') + '">' + ((lead.activity && lead.activity.label) ? ('● ' + esc(lead.activity.label)) : '● 空闲待命') + '</div>' +
      (lead.activity && lead.activity.lastPreview ? '<div class="dtc-fleetMission">' + esc(lead.activity.lastPreview) + '</div>' : '') +
      '<button type="button" class="dtc-fleetBtn" data-select-agent="' + esc(team.leadId) + '">查看主控指令流 →</button>' +
    '</div>';

    var memberCards = members.map(function (m) {
      var act = m.activity || {};
      var busy = act.kind === "tool" || act.kind === "thinking";
      var mission = (m.assignment && m.assignment.description) || m.description || "";
      return '<div class="dtc-fleetCard">' +
        '<div class="dtc-fleetCardHead">' +
          '<span class="dtc-avatar" style="' + avatarStyle(m.name) + '">' + esc(initials(m.name)) + '</span>' +
          '<div class="dtc-fleetNameRow"><div class="dtc-fleetName">' + esc(m.name || m.id) + '</div><span class="dtc-fleetRoleTag">' + esc(phaseLabel(m.phase) || "协同智能体") + '</span></div>' +
        '</div>' +
        '<div class="dtc-fleetActivity' + (busy ? ' busy' : '') + '"><span class="dtc-dot ' + memberDot(m) + '"></span>' + esc(act.label || "空闲") + (act.lastTime ? ' · ' + ago(act.lastTime) : '') + '</div>' +
        '<div class="dtc-fleetStats"><span><b>' + (m.toolCalls || 0) + '</b> 次工具</span><span><b>' + (m.messages || 0) + '</b> 条消息</span><span><b>' + (m.stepCount || 0) + '</b> 步骤</span></div>' +
        (mission ? '<div class="dtc-fleetMission">🎯 ' + esc(mission) + '</div>' : '') +
        '<button type="button" class="dtc-fleetBtn" data-select-agent="' + esc(m.id) + '">进入独立会话流 (View Stream) →</button>' +
      '</div>';
    }).join("");

    var tasksHtml = "";
    if (tasks.length > 0) {
      tasksHtml = '<div class="dtc-cockpitTasks"><div class="dtc-tasksGrid">' + tasks.map(function (task) {
        var st = taskState(task);
        var hasOwner = Boolean(task.ownerId);
        return '<div class="dtc-taskCardItem' + (hasOwner ? '' : ' is-unassigned') + '" data-select-agent="' + esc(task.ownerId || "") + '">' +
          '<div class="dtc-taskCardHead"><span class="dtc-id">' + esc(task.id) + '</span><span class="dtc-taskCardTitle">' + esc(task.subject || "(无标题)") + '</span><span class="dtc-chip ' + st.cls + '">' + st.badge + '</span></div>' +
          (task.description ? '<div class="dtc-taskCardDesc">' + esc(task.description) + '</div>' : '') +
          '<div class="dtc-taskCardFoot">' +
            (task.ownerName ? '<span class="dtc-ownerPill"><span class="dtc-avatarMini" style="' + avatarStyle(task.ownerName) + '">' + esc(initials(task.ownerName)) + '</span><span>' + esc(task.ownerName) + '</span></span>' : '<span class="dtc-ownerPill unowned">未指派</span>') +
            (hasOwner ? '<span style="font-size:10.5px;color:var(--dtc-brand)">查看对话 →</span>' : '<span style="font-size:10.5px;color:var(--dtc-dim2)">待认领</span>') +
          '</div>' +
        '</div>';
      }).join("") + '</div></div>';
    } else {
      tasksHtml = '<div class="dtc-autoFlow">' +
        '<div class="dtc-flowStep"><span class="dtc-avatarMini" style="background:#4f46e5">主</span>Lead 任务指派</div><span class="dtc-flowArrow">→</span>' +
        (members.length > 0 ? '<div class="dtc-flowStep"><span class="dtc-avatarMini" style="' + avatarStyle(members[0].name) + '">' + esc(initials(members[0].name)) + '</span>' + esc(members[0].name) + '</div>' : '') +
        (members.length > 1 ? '<span class="dtc-flowArrow">→</span><div class="dtc-flowStep"><span class="dtc-avatarMini" style="' + avatarStyle(members[1].name) + '">' + esc(initials(members[1].name)) + '</span>' + esc(members[1].name) + '</div>' : '') +
        '<span class="dtc-flowArrow">→</span><div class="dtc-flowStep">成果交付与归档</div>' +
      '</div>';
    }

    return '<div class="dtc-cockpit">' +
      heroHtml +
      metricsHtml +
      '<div class="dtc-sectionHead"><div class="dtc-sectionTitle">智能体集群全貌 (Agent Fleet)</div><div class="dtc-sectionSub">点击进入独立执行流与工具链追踪</div></div>' +
      '<div class="dtc-fleetGrid">' + leadCard + memberCards + '</div>' +
      '<div class="dtc-sectionHead"><div class="dtc-sectionTitle">协同工作流与任务派发 (Tasks & Workflow)</div></div>' +
      tasksHtml +
    '</div>';
  }

  function renderMissionCard() {
    if (!nodes.context) return;
    if (state.selected === "__overview__" || !state.team) {
      setHtml(nodes.context, "");
      return;
    }
    var team = state.team;
    var member = null;
    for (var i = 0; i < team.members.length; i += 1) {
      if (team.members[i].id === state.selected) { member = team.members[i]; break; }
    }
    if (!member || !member.assignment) { setHtml(nodes.context, ""); return; }
    var assign = member.assignment;
    var desc = assign.description || member.description || "";
    var prompt = assign.prompt || "";
    if (!desc && !prompt) { setHtml(nodes.context, ""); return; }
    setHtml(nodes.context, '<div class="dtc-missionCard">' +
      '<div class="dtc-missionHead">' +
        '<span class="dtc-missionIcon">🎯</span>' +
        '<span class="dtc-missionTitle">任务目标: ' + esc(desc) + '</span>' +
        (prompt ? '<button type="button" class="dtc-missionToggle" id="missionPromptBtn">' + (state.showMissionPrompt ? "收起 Prompt ↑" : "查看 Prompt ▾") + '</button>' : '') +
      '</div>' +
      (state.showMissionPrompt && prompt ? '<pre class="dtc-missionPrompt">' + esc(prompt) + '</pre>' : '') +
    '</div>');
  }

  function renderSectBar() {
    var transcript = state.transcript;
    var visibleCount = transcript ? transcript.items.filter(function (item) { return item.kind !== "context"; }).length : 0;
    var isOverview = state.selected === "__overview__";
    setHtml(nodes.sectBar, '<div class="dtc-sectBar dtc-guide"><b>' + (isOverview ? "协同链路与实时动态" : "完整聊天记录") + '</b>' +
      (visibleCount > 0 ? '<span class="dtc-sectNum">' + visibleCount + "</span>" : "") +
      '<span class="dtc-guideText">' +
        '<span class="dtc-guideItem"><span class="dtc-guideNo">①</span>收到的任务（左）</span>' +
        '<span class="dtc-guideItem"><span class="dtc-guideNo">②</span>他的执行过程（中间）</span>' +
        '<span class="dtc-guideItem"><span class="dtc-guideNo">③</span>他的回复（右）</span>' +
      "</span></div>");
  }

  function stepListHtml(block, roleName) {
    var all = block.steps || [];
    var thinks = all.filter(function (s) { return s.kind === "reasoning"; });
    var steps = all.filter(function (s) { return s.kind !== "reasoning"; });
    if (steps.length === 0 && thinks.length === 0) return "";
    var totalMs = 0;
    steps.forEach(function (s) { if (s.time && s.resultTime) totalMs += Math.max(0, s.resultTime - s.time); });
    var totalText = totalMs > 0 ? (totalMs < 1000 ? totalMs + "ms" : (totalMs / 1000).toFixed(1) + "s") : "";
    var html = '<div class="dtc-steps"><div class="dtc-stepsHead">' + (block.standalone ? "他的执行过程" : "执行") + " · " + steps.length + " 步" + (totalText ? " · 共 " + totalText : "") + "</div>";
    if (steps.length > 0) {
      html += '<ol class="dtc-stepList">' + steps.map(function (step, index) {
        var done = step.ok !== undefined ? step.ok : (step.result != null ? !step.isError : null);
        var cls = done === null ? "" : done ? " ok" : " bad";
        var stateText = done === null ? "运行中" : done ? "完成" : "失败";
        var dur = duration(step);
        var described = describeStep(step);
        var subHtml = "";
        if (step.subSteps && step.subSteps.length > 0) {
          subHtml = '<div class="dtc-subSteps">' + step.subSteps.map(function (sub) {
            var subDesc = describeStep(sub);
            return '<div class="dtc-subStep' + (sub.isError ? " bad" : "") + '"><span>' + (sub.isError ? "✕" : "•") + "</span><span>" + esc(subDesc.title) + "</span></div>";
          }).join("") + "</div>";
        }
        return '<li class="dtc-stepItem' + cls + '"><span class="dtc-stepNo">' + (index + 1) + "</span>" +
          '<div class="dtc-stepMain"><div class="dtc-stepTitle" title="' + esc(described.full || described.title) + '">' + esc(described.title) + "</div>" +
          '<div class="dtc-stepMeta">' + esc([stateText, described.detail, dur].filter(Boolean).join(" · ")) + "</div></div>" +
          '<details class="dtc-stepFold"><summary class="dtc-stepMore">详情</summary>' + subHtml + '<pre class="dtc-pre">' +
          esc((step.args || "") + (step.result != null ? "\n\n— 结果 —\n" + step.result : "")) + "</pre></details></li>";
      }).join("") + "</ol>";
    }
    if (thinks.length > 0) {
      html += '<details class="dtc-thinkFold"><summary>查看 ' + thinks.length + ' 段思考</summary>' +
        thinks.map(function (t) { return '<div class="dtc-thinkText">' + esc(t.text || "") + "</div>"; }).join("") + "</details>";
    }
    return html + "</div>";
  }

  function renderFeed() {
    var feed = nodes.feed;
    if (state.error && !state.team) {
      setHtml(feed, '<div class="dtc-empty"><div class="dtc-emptyIcon">⚠</div><h4>读不到团队数据</h4><p>' + esc(state.error) + '</p></div>');
      nodes.jumpBtn.hidden = true;
      return;
    }
    if (!state.team) {
      if (state.updatedAt === 0) return;
      setHtml(feed, '<div class="dtc-empty"><div class="dtc-emptyIcon">◈</div><h4>还没有协同团队</h4><p>在任意会话里用自然语言让我组建团队，例如「组个团队做这件事」。成员、任务看板、会话流将自动汇聚在此。</p></div>');
      nodes.jumpBtn.hidden = true;
      return;
    }
    if (state.selected === "__overview__") {
      setHtml(feed, renderOverview());
      if (state.lastSelected !== "__overview__") feed.scrollTop = 0;
      nodes.jumpBtn.hidden = true;
      return;
    }
    var transcript = state.transcript;
    var nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    if (!transcript) {
      setHtml(feed, '<div class="dtc-empty"><div class="dtc-emptyIcon">◈</div><h4>选择左侧智能体</h4><p>点击智能体名册或任务负责人，查看完整交互流与工具链追踪。</p></div>');
      nodes.jumpBtn.hidden = true;
      return;
    }
    var isLead = state.selected === state.leadId;
    var team = state.team;
    var member = null;
    if (team && !isLead) {
      for (var i = 0; i < team.members.length; i += 1) { if (team.members[i].id === state.selected) { member = team.members[i]; break; } }
    }
    var roleName = isLead ? "Lead" : ((member && (member.name || member.id)) || "成员");
    var visible = transcript.items.filter(function (item) { return item.kind !== "context"; });
    if (visible.length === 0) {
      setHtml(feed, '<div class="dtc-empty"><div class="dtc-emptyIcon">◈</div><h4>没有可显示的记录</h4></div>');
      nodes.jumpBtn.hidden = true;
      return;
    }

    var blocks = [];
    visible.forEach(function (item) {
      var isStep = item.kind === "tool" || item.kind === "tool_result" || item.kind === "reasoning";
      if (isStep) {
        var last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
        if (last && (last.type === "assistant" || last.type === "steps")) last.steps.push(item);
        else blocks.push({ type: "steps", steps: [item] });
        return;
      }
      blocks.push({ type: item.kind, item: item, steps: [] });
    });
    for (var bi = blocks.length - 1; bi >= 0; bi -= 1) {
      if (blocks[bi].type === "assistant") { blocks[bi].isFinal = true; break; }
    }
    var truncHtml = transcript.truncated
      ? '<div class="dtc-truncHint">仅显示最近 ' + transcript.items.length + " 条记录（共 " + transcript.total + " 条）</div>"
      : "";
    var html = truncHtml + blocks.map(function (block) {
      if (block.type === "steps") {
        block.standalone = true;
        return stepListHtml(block);
      }
      if (block.type === "team") return '<div class="dtc-event">' + esc(block.item.text) + "</div>";
      if (block.type !== "user" && block.type !== "assistant") return "";
      var isMine = block.type === "user";
      var time = clock(block.item.time);
      var chips = block.steps && block.steps.length ? stepListHtml(block) : "";
      var bodyHtml = formatRichText(block.item.text);
      /* 同面板端：成员会话里的任务书来自 Lead（或转达的 Agent），不是浏览器用户本人。 */
      var sender = block.item && block.item.sender ? block.item.sender : null;
      var mineLabel = (sender && sender.name) || (isLead ? "用户" : "Lead 主控");
      var mineAvatar = sender && sender.kind === "human" ? "我" : (sender && sender.kind === "lead" ? "主" : initials(mineLabel));
      var mineTag = sender
        ? (sender.relay ? "转达" : (sender.kind === "lead" ? "任务书" : ""))
        : (isLead ? "" : "任务书");
      return '<div class="dtc-talk ' + (isMine ? "out" : "in") + ' dtc-feedMsg">' +
        '<span class="dtc-talkAvatar" style="' + (isMine ? "background:linear-gradient(135deg,#4f46e5,#7c3aed)" : avatarStyle(roleName)) + '">' +
          esc(isMine ? mineAvatar : initials(roleName)) + "</span>" +
        '<div class="dtc-talkBody"><div class="dtc-talkLabel"><b>' + esc(isMine ? mineLabel : roleName) + "</b>" +
          (isMine && mineTag ? '<span class="dtc-roleTag">' + mineTag + '</span>' : "") +
          (!isMine && block.isFinal ? '<span class="dtc-roleTag reply">回复</span>' : "") +
          "<span>" + time + "</span></div>" +
        '<div class="dtc-bubble ' + (isMine ? "out" : "in") + ' dtc-md">' + bodyHtml + "</div>" + chips +
        "</div></div>";
    }).join("");
    var changed = setHtml(feed, html);
    var grew = changed && typeof state.lastCount === "number" && visible.length > state.lastCount;
    state.lastCount = visible.length;
    if (changed && state.stick) feed.scrollTop = feed.scrollHeight;
    if (grew && feed.lastElementChild && feed.lastElementChild.classList) {
      var lastEl = feed.lastElementChild;
      lastEl.classList.add("dtc-in");
      setTimeout(function () { lastEl.classList.remove("dtc-in"); }, 260);
    }
    nodes.jumpBtn.hidden = nearBottom || state.stick;
  }

  function renderStreamHead() {
    var team = state.team;
    var transcript = state.transcript;
    if (!team) {
      nodes.streamKind.textContent = "—";
      nodes.streamTitle.textContent = "会话";
      nodes.streamMeta.textContent = "";
      return;
    }
    if (state.selected === "__overview__") {
      nodes.streamKind.textContent = "总览";
      nodes.streamTitle.textContent = "团队指挥中枢 · 全局监控";
      nodes.streamMeta.textContent = (team.members.length + 1) + " 智能体 · " + team.tasks.length + " 项任务";
      return;
    }
    var isLead = state.selected === state.leadId;
    nodes.streamKind.textContent = isLead ? "Lead" : "成员";
    nodes.streamTitle.textContent = isLead ? (team.title || team.leadId) : ((transcript && (transcript.label || transcript.title)) || state.selected);
    var meta = [];
    if (transcript && transcript.model) meta.push(transcript.model);
    if (transcript && transcript.activity && transcript.activity.label) meta.push(transcript.activity.label);
    if (transcript) meta.push(transcript.total + " 条记录");
    nodes.streamMeta.textContent = meta.join("  ·  ");
  }

  function render() {
    nodes.clock.textContent = clock(state.updatedAt);
    if (state.error) {
      nodes.liveDot.style.background = "var(--dtc-bad)";
      nodes.liveText.textContent = state.error;
    } else {
      nodes.liveDot.style.background = "";
      nodes.liveText.textContent = "实时连接";
    }
    renderTeams();
    renderTree();
    renderStreamHead();
    renderMissionCard();
    renderSectBar();
    renderFeed();
    state.lastSelected = state.selected;
  }

  function renderTeams() {
    /* B2：签名必须覆盖真正渲染的四个字段，否则团队标题 / 人数变化时下拉永久冻结。 */
    var signature = state.teams.map(function (item) { return [item.leadId, item.title, item.memberCount, item.openTaskCount].join("\u0001"); }).join("\u0002");
    if (nodes.teamSelect.getAttribute("data-signature") === signature) {
      nodes.teamSelect.value = state.leadId || "";
      return;
    }
    nodes.teamSelect.setAttribute("data-signature", signature);
    nodes.teamSelect.innerHTML = state.teams.map(function (item) {
      return '<option value="' + esc(item.leadId) + '">' + esc((item.title || item.leadId) + " · " + item.memberCount + " 人 · " + item.openTaskCount + " 任务") + "</option>";
    }).join("");
    nodes.teamSelect.value = state.leadId || "";
  }

  async function tick() {
    /* B3：同一时刻只允许一轮拉取；期间被再次触发就记一个待跑标记，本轮结束后补跑。
       同时推进序号，让在途的旧 tick 丢弃自身，避免把用户刚切换的 selected / transcript 回滚成旧值。 */
    if (inFlight) { rerunPending = true; requestSeq += 1; return; }
    inFlight = true;
    var seq = (requestSeq += 1);
    try {
      if (!state.api) {
        var found = await findApi();
        if (seq !== requestSeq) return;
        state.api = found;
        if (!state.api) { state.error = "没有找到本地数据服务"; render(); return; }
      }
      var teamsResponse = await getJson(state.api + "/api/teams", DATA_TIMEOUT_MS);
      if (seq !== requestSeq) return;
      state.teams = teamsResponse.teams || [];
      state.error = null;
      if (state.teams.length === 0) {
        state.team = null; state.leadId = null; state.selected = null; state.transcript = null; state.updatedAt = Date.now(); render(); return;
      }
      var keep = state.leadId && state.teams.some(function (item) { return item.leadId === state.leadId; });
      state.leadId = keep ? state.leadId : state.teams[0].leadId;
      var teamResponse = await getJson(state.api + "/api/team?lead=" + encodeURIComponent(state.leadId), DATA_TIMEOUT_MS);
      if (seq !== requestSeq) return;
      state.team = teamResponse.team;
      var exists = state.selected && (state.selected === state.leadId || state.selected === "__overview__" || state.team.members.some(function (member) { return member.id === state.selected; }));
      if (!exists) state.selected = state.team.members.length > 0 ? state.team.members[0].id : state.leadId;

      if (state.selected !== "__overview__") {
        try {
          var transcriptResponse = await getJson(state.api + "/api/session/" + encodeURIComponent(state.selected) + "?limit=200", DATA_TIMEOUT_MS);
          if (seq !== requestSeq) return;
          state.transcript = transcriptResponse.transcript;
        } catch (error) {
          if (seq !== requestSeq) return;
          state.transcript = null;
        }
      } else {
        state.transcript = null;
      }
      state.updatedAt = Date.now();
      render();
    } catch (error) {
      if (seq !== requestSeq) return;
      if (error && !error.status) state.api = null;
      state.error = "读取失败：" + (error && error.message ? error.message : String(error));
      render();
    } finally {
      inFlight = false;
      if (rerunPending) { rerunPending = false; tick(); }
    }
  }

  function selectTarget(targetId) {
    if (!targetId) return;
    var changed = state.selected !== targetId;
    state.selected = targetId;
    state.stick = true;
    state.lastCount = undefined;
    state.showMissionPrompt = false;
    state.expandedTask = null;
    if (changed) {
      state.transcript = null;
      render();
    }
    tick();
  }

  nodes.teamSelect.addEventListener("change", function () {
    state.leadId = nodes.teamSelect.value;
    state.selected = null;
    state.transcript = null;
    state.stick = true;
    state.lastCount = undefined;
    state.expandedTask = null;
    state.openTurns = {};
    state.showMissionPrompt = false;
    render();
    tick();
  });

  if (nodes.overviewNavBtn && nodes.overviewNavBtn.addEventListener) {
    nodes.overviewNavBtn.addEventListener("click", function () {
      selectTarget("__overview__");
    });
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", function (event) {
      if (!event || !event.target || typeof event.target.closest !== "function") return;
      var missionBtn = event.target.closest("#missionPromptBtn");
      if (missionBtn) {
        state.showMissionPrompt = !state.showMissionPrompt;
        renderMissionCard();
        return;
      }
      var agentBtn = event.target.closest("[data-select-agent]");
      if (agentBtn) {
        var agentId = agentBtn.getAttribute("data-select-agent");
        if (agentId) selectTarget(agentId);
      }
    });
  }

  /* 名册 / 任务板的点击与键盘共用同一套命中逻辑（B7：任务行可键盘操作，不重复触发）。 */
  function activateTreeTarget(target) {
    if (!target || typeof target.closest !== "function") return;
    var detailBtn = target.closest("[data-detail]");
    if (detailBtn) {
      var detailId = detailBtn.getAttribute("data-detail");
      state.expandedTask = state.expandedTask === detailId ? null : detailId;
      renderTree();
      return;
    }
    var memberBtn = target.closest("[data-member]");
    if (memberBtn) {
      selectTarget(memberBtn.getAttribute("data-member"));
      return;
    }
    var taskCard = target.closest("[data-task]");
    if (taskCard) {
      var owner = taskCard.getAttribute("data-owner");
      if (owner) {
        selectTarget(owner);
        return;
      }
      var taskId = taskCard.getAttribute("data-task");
      state.expandedTask = state.expandedTask === taskId ? null : taskId;
      renderTree();
      return;
    }
    var reqHead = target.closest("[data-req]");
    if (reqHead) {
      var turn = Number(reqHead.getAttribute("data-req"));
      var requests = state.team ? buildRequests(state.team) : [];
      var current = state.openTurns[turn];
      if (current === undefined) {
        var index = requests.findIndex(function (item) { return item.turn === turn; });
        current = index === requests.length - 1;
      }
      state.openTurns[turn] = !current;
      renderTree();
    }
  }

  nodes.tree.addEventListener("click", function (event) {
    activateTreeTarget(event && event.target);
  });

  nodes.tree.addEventListener("keydown", function (event) {
    if (!event || (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar")) return;
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    /* 内部真实 button（▾）的 Enter/Space 会自己产生 click，这里跳过避免双触发。 */
    if (target.closest("button")) return;
    if (!target.closest("[data-task]")) return;
    event.preventDefault();
    activateTreeTarget(target);
  });

  nodes.feed.addEventListener("scroll", function () {
    var feed = nodes.feed;
    var nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    state.stick = nearBottom;
    nodes.jumpBtn.hidden = nearBottom;
  });

  nodes.jumpBtn.addEventListener("click", function () {
    state.stick = true;
    nodes.jumpBtn.hidden = true;
    nodes.feed.scrollTop = nodes.feed.scrollHeight;
  });

  tick();
  setInterval(tick, POLL_MS);
})();