/**
 * dsh-team-console — Client 半侧（左侧栏「团队」面板）。
 *
 * 挂载点（与官方 ui-schedule / ui-plugin-manager 相同）：
 *   sidebar.panellist  → 左侧栏导航行（图标 + 标签）
 *   main (keyed)       → 主区域面板页面
 *
 * 样式完全走 DSH 的 --dsw-* 设计令牌，因此自动跟随宿主主题（浅色 / 深色），
 * 插件本身不提供主题切换；令牌缺失时回退到 CSS 系统色（Canvas / CanvasText / GrayText），
 * 在两种主题下都有合理的对比度。
 *
 * 数据来自 Host 半侧启动的本地只读 API（默认 127.0.0.1:4318，端口占用会顺延）。
 * 面板只做展示：创建团队、派活仍然靠自然语言对话。
 * 无构建步骤：DSH 通过包清单的 dsh.client 声明直接加载本文件。
 */
window.__ModuleLoader__.load({
  id: "dsh-team-console",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var PANEL_ID = "team-console";
    var API_PORTS = [];
    for (var p = 4318; p < 4338; p += 1) API_PORTS.push(p);
    var POLL_MS = 2500;

    var CSS = "\n/* ============================================================================\n   dsh-team-console · 视觉系统 0.9.1\n   单一强调色 + 中性灰阶；层次靠「表面 / 描边 / 极轻阴影 / 留白」表达。\n   面板端继承 DSH 令牌（--dsw-alias-*）；独立端的 --dtc-* 由 tools/build-css.mjs 注入。\n   ========================================================================== */\n\n/* --- 1. 基础令牌与画布 --------------------------------------------------- */\n.dtc-root{container-type:inline-size;container-name:dtc;--dtc-bg:var(--dsw-alias-bg-base,#f6f7fb);--dtc-card:var(--dsw-alias-bg-layer-1,#ffffff);--dtc-card2:var(--dsw-alias-bg-layer-2,#f4f6fa);--dtc-card3:var(--dsw-alias-bg-layer-3,#e9edf5);--dtc-edge:var(--dsw-alias-border-l1,rgba(15,23,42,.08));--dtc-edge2:var(--dsw-alias-border-l2,rgba(15,23,42,.16));--dtc-text:var(--dsw-alias-label-primary,#0f172a);--dtc-dim:var(--dsw-alias-label-secondary,#48566b);--dtc-dim2:var(--dsw-alias-label-tertiary,#63718a);--dtc-brand:var(--dsw-alias-brand-primary,#4f46e5);--dtc-ok:var(--dsw-alias-state-success-primary,#047857);--dtc-warn:var(--dsw-alias-state-warn-primary,#b45309);--dtc-bad:var(--dsw-alias-state-error-primary,#dc2626);--dtc-hover:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.045));--dtc-active:var(--dsw-alias-interactive-bg-active,rgba(79,70,229,.09));--dtc-r:14px;--dtc-r-sm:10px;--dtc-shadow-sm:0 1px 2px light-dark(rgba(15,23,42,.05),rgba(0,0,0,.5)),0 1px 3px light-dark(rgba(15,23,42,.04),rgba(0,0,0,.42));--dtc-shadow-md:0 12px 28px -12px light-dark(rgba(15,23,42,.18),rgba(0,0,0,.66)),0 4px 10px -4px light-dark(rgba(15,23,42,.08),rgba(0,0,0,.5));--dtc-shadow-glow:0 0 0 1px color-mix(in oklab,var(--dtc-brand) 18%,transparent),0 10px 24px -12px color-mix(in oklab,var(--dtc-brand) 45%,transparent);--dtc-mono:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,\"Cascadia Code\",monospace);display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dtc-bg);color:var(--dtc-text);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif);font-size:13px;line-height:1.6;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}\n.dtc-root *{box-sizing:border-box}\n.dtc-root ::selection{background:color-mix(in oklab,var(--dtc-brand) 22%,transparent);color:var(--dtc-text)}\n.dtc-root :focus-visible{outline:2px solid color-mix(in oklab,var(--dtc-brand) 70%,transparent);outline-offset:2px}\n.dtc-root b,.dtc-root strong{font-weight:650}\n\n/* --- 2. 顶栏 ------------------------------------------------------------- */\n.dtc-top{display:flex;align-items:center;gap:12px;padding:0 16px;height:52px;flex:none;position:relative;z-index:10;border-bottom:1px solid var(--dtc-edge);background:color-mix(in oklab,var(--dtc-card) 84%,transparent);backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6)}\n.dtc-brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:14px;letter-spacing:-.01em;min-width:0}\n.dtc-mark{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-size:12px;color:var(--dtc-card);flex:none;background:linear-gradient(145deg,color-mix(in oklab,var(--dtc-brand) 82%,#ffffff) 0%,var(--dtc-brand) 48%,color-mix(in oklab,var(--dtc-brand) 52%,#8b5cf6) 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 10px -3px color-mix(in oklab,var(--dtc-brand) 55%,transparent)}\n.dtc-brandTitle{font-weight:700;color:var(--dtc-text);letter-spacing:-.01em;white-space:nowrap}\n.dtc-brandBadge{font-size:10px;font-weight:650;letter-spacing:.03em;padding:2px 8px;border-radius:999px;background:color-mix(in oklab,var(--dtc-brand) 9%,transparent);border:1px solid color-mix(in oklab,var(--dtc-brand) 18%,transparent);color:var(--dtc-brand);white-space:nowrap}\n.dtc-selectWrap{position:relative;display:flex;align-items:center;min-width:0}\n.dtc-team{appearance:none;-webkit-appearance:none;border:1px solid var(--dtc-edge);background:var(--dtc-card);color:var(--dtc-text);border-radius:9px;height:28px;padding:0 26px 0 10px;font-size:12px;font-weight:550;font-family:inherit;max-width:300px;text-overflow:ellipsis;cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background-color .16s ease}\n.dtc-team:hover{border-color:var(--dtc-edge2);background:var(--dtc-card2)}\n.dtc-team:focus-visible{outline:0;border-color:var(--dtc-brand);box-shadow:0 0 0 3px color-mix(in oklab,var(--dtc-brand) 16%,transparent)}\n.dtc-selectWrap:after{content:\"\";position:absolute;right:10px;top:50%;width:6px;height:6px;margin-top:-4.5px;border-right:1.5px solid var(--dtc-dim2);border-bottom:1.5px solid var(--dtc-dim2);border-radius:1px;transform:rotate(45deg);pointer-events:none}\n.dtc-live{margin-left:auto;display:flex;align-items:center;gap:8px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dtc-edge);background:color-mix(in oklab,var(--dtc-card2) 72%,transparent);color:var(--dtc-dim);font-size:11px;white-space:nowrap;min-width:0}\n.dtc-live>span:not(.dtc-pulse):not(.dtc-clock){overflow:hidden;text-overflow:ellipsis}\n.dtc-pulse{width:6px;height:6px;border-radius:50%;background:var(--dtc-ok);flex:none;position:relative;box-shadow:0 0 0 0 color-mix(in oklab,var(--dtc-ok) 60%,transparent);animation:dtcRadar 2.4s infinite cubic-bezier(0,0,.2,1)}\n@keyframes dtcRadar{0%{box-shadow:0 0 0 0 color-mix(in oklab,var(--dtc-ok) 60%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}\n.dtc-clock{font-variant-numeric:tabular-nums;color:var(--dtc-dim2);font-size:10.5px;padding-left:8px;border-left:1px solid var(--dtc-edge);flex:none}\n\n/* --- 3. 主布局 ----------------------------------------------------------- */\n.dtc-main{flex:1;min-height:0;display:grid;grid-template-columns:296px minmax(0,1fr);background:var(--dtc-bg)}\n\n/* --- 4. 左侧指挥栏 ------------------------------------------------------- */\n.dtc-rail{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:14px 12px 40px;display:flex;flex-direction:column;gap:16px;background:color-mix(in oklab,var(--dtc-card2) 55%,var(--dtc-bg));border-right:1px solid var(--dtc-edge)}\n.dtc-overviewBtn{display:flex;align-items:center;gap:10px;width:100%;padding:10px;border-radius:12px;border:1px solid var(--dtc-edge);background:var(--dtc-card);color:inherit;font:inherit;text-align:left;cursor:pointer;box-shadow:var(--dtc-shadow-sm);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease,background-color .16s ease}\n.dtc-overviewBtn:hover{border-color:var(--dtc-edge2);transform:translateY(-1px);box-shadow:var(--dtc-shadow-md)}\n.dtc-overviewBtn.is-on{border-color:color-mix(in oklab,var(--dtc-brand) 40%,transparent);background:linear-gradient(180deg,color-mix(in oklab,var(--dtc-brand) 8%,var(--dtc-card)),var(--dtc-card));box-shadow:var(--dtc-shadow-glow)}\n.dtc-overviewIcon{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:13px;background:color-mix(in oklab,var(--dtc-brand) 11%,transparent);border:1px solid color-mix(in oklab,var(--dtc-brand) 16%,transparent);color:var(--dtc-brand);flex:none}\n.dtc-overviewText{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}\n.dtc-overviewText b{font-size:12.5px;font-weight:650;color:var(--dtc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dtc-overviewText small{font-size:10.5px;color:var(--dtc-dim2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dtc-overviewBadge{font-size:9.5px;font-weight:650;padding:1px 7px;border-radius:999px;background:var(--dtc-card3);color:var(--dtc-dim);border:1px solid transparent;flex:none}\n.dtc-overviewBtn.is-on .dtc-overviewBadge{background:var(--dtc-brand);color:var(--dtc-card)}\n\n/* 栏内分组标题 */\n.dtc-railSection{display:flex;flex-direction:column;gap:6px;min-width:0}\n.dtc-railSection+.dtc-railSection{border-top:1px solid color-mix(in oklab,var(--dtc-edge) 92%,transparent);padding-top:14px}\n.dtc-railHead{display:flex;align-items:center;justify-content:space-between;padding:2px 8px 0;color:var(--dtc-dim2);font-size:10px;font-weight:700;letter-spacing:.06em}\n.dtc-railHead b{min-width:18px;text-align:center;font-size:10px;font-weight:650;letter-spacing:0;color:var(--dtc-dim);background:var(--dtc-card3);padding:0 6px;border-radius:6px;line-height:16px;font-variant-numeric:tabular-nums}\n\n/* 成员行 */\n.dtc-member{position:relative;display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:9px;align-items:center;width:100%;padding:7px 8px;border-radius:10px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .14s ease,box-shadow .14s ease}\n.dtc-member:before{content:\"\";position:absolute;left:0;top:50%;width:2px;height:18px;border-radius:2px;background:var(--dtc-brand);transform:translateY(-50%) scaleY(0);transition:transform .16s ease}\n.dtc-member:hover{background:var(--dtc-hover)}\n.dtc-member:hover:before{transform:translateY(-50%) scaleY(1);opacity:.45}\n.dtc-member.is-on{background:color-mix(in oklab,var(--dtc-brand) 8%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--dtc-brand) 22%,transparent)}\n.dtc-member.is-on:before{transform:translateY(-50%) scaleY(1);opacity:1}\n.dtc-member:focus-visible{outline-offset:-1px}\n.dtc-avatar{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:10.5px;font-weight:700;color:#fff;letter-spacing:0;flex:none;box-shadow:0 0 0 2px color-mix(in oklab,var(--dtc-card) 92%,transparent),0 2px 5px -2px rgba(15,23,42,.35)}\n.dtc-memberBody{min-width:0}\n.dtc-memberName{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;min-width:0;line-height:1.35}\n.dtc-memberName span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dtc-memberActivity{font-size:10.5px;color:var(--dtc-dim2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}\n.dtc-memberActivity.is-busy{color:var(--dtc-ok);font-weight:550}\n.dtc-phase{flex:none;font-size:9.5px;font-weight:650;padding:0 5px;border-radius:6px;border:1px solid var(--dtc-edge);color:var(--dtc-dim);line-height:15px;background:var(--dtc-card)}\n.dtc-phase.phase-active{color:var(--dtc-ok);border-color:color-mix(in oklab,var(--dtc-ok) 32%,transparent);background:color-mix(in oklab,var(--dtc-ok) 9%,transparent)}\n.dtc-phase.phase-provisioning{color:var(--dtc-warn);border-color:color-mix(in oklab,var(--dtc-warn) 32%,transparent);background:color-mix(in oklab,var(--dtc-warn) 9%,transparent)}\n.dtc-phase.phase-failed{color:var(--dtc-bad);border-color:color-mix(in oklab,var(--dtc-bad) 32%,transparent);background:color-mix(in oklab,var(--dtc-bad) 9%,transparent)}\n.dtc-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dtc-dim2)}\n.dtc-dot.ok{background:var(--dtc-ok);box-shadow:0 0 0 3px color-mix(in oklab,var(--dtc-ok) 14%,transparent)}\n.dtc-dot.warn{background:var(--dtc-warn);box-shadow:0 0 0 3px color-mix(in oklab,var(--dtc-warn) 14%,transparent)}\n.dtc-dot.bad{background:var(--dtc-bad);box-shadow:0 0 0 3px color-mix(in oklab,var(--dtc-bad) 14%,transparent)}\n.dtc-dot.busy{animation:dtcBlink 1.6s infinite cubic-bezier(.4,0,.2,1)}\n@keyframes dtcBlink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(1.15)}}\n\n/* 请求卡片 */\n.dtc-req{border-radius:12px;background:var(--dtc-card);border:1px solid var(--dtc-edge);overflow:hidden;transition:border-color .16s ease,box-shadow .16s ease}\n.dtc-req:hover{border-color:var(--dtc-edge2);box-shadow:var(--dtc-shadow-sm)}\n.dtc-req.is-open{border-color:color-mix(in oklab,var(--dtc-brand) 28%,var(--dtc-edge));box-shadow:var(--dtc-shadow-sm)}\n.dtc-reqHead{display:flex;flex-direction:column;gap:5px;width:100%;padding:10px 12px;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}\n.dtc-reqHead:focus-visible{outline-offset:-2px}\n.dtc-reqTop{display:flex;align-items:center;gap:6px}\n.dtc-reqIndex{font-size:9.5px;font-weight:650;letter-spacing:.02em;color:var(--dtc-brand);background:color-mix(in oklab,var(--dtc-brand) 9%,transparent);border-radius:6px;padding:1px 6px;line-height:15px}\n.dtc-chevron{margin-left:auto;color:var(--dtc-dim2);font-size:12px;line-height:1;width:16px;height:16px;display:grid;place-items:center;border-radius:5px;transition:transform .2s ease,background-color .16s ease}\n.dtc-reqHead:hover .dtc-chevron{background:var(--dtc-hover);color:var(--dtc-text)}\n.dtc-req.is-open .dtc-chevron{transform:rotate(180deg)}\n.dtc-reqTitle{font-size:12.5px;font-weight:600;line-height:1.45;color:var(--dtc-text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.dtc-reqMeta{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dtc-dim2);font-variant-numeric:tabular-nums;flex-wrap:wrap}\n.dtc-avatars{display:flex;align-items:center}\n.dtc-avatarMini{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:9px;font-weight:700;color:#fff;letter-spacing:0;border:2px solid var(--dtc-card);margin-right:-6px;box-shadow:0 1px 2px rgba(15,23,42,.15)}\n.dtc-avatars .dtc-avatarMini:last-child{margin-right:0}\n.dtc-reqBar{height:4px;border-radius:99px;background:color-mix(in oklab,var(--dtc-card3) 55%,var(--dtc-card));overflow:hidden;margin-top:3px}\n.dtc-reqBarFill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--dtc-brand),color-mix(in oklab,var(--dtc-ok) 65%,var(--dtc-brand)));transition:width .4s cubic-bezier(.4,0,.2,1)}\n.dtc-children{display:flex;flex-direction:column;gap:2px;padding:4px 8px 10px 12px;border-top:1px solid var(--dtc-edge);position:relative}\n.dtc-children:before{content:\"\";position:absolute;left:7px;top:8px;bottom:12px;width:1px;background:color-mix(in oklab,var(--dtc-edge2) 60%,transparent)}\n\n/* 任务行 */\n.dtc-task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;padding:6px 8px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:background-color .14s ease,border-color .14s ease}\n.dtc-task:hover{background:var(--dtc-hover)}\n.dtc-task:focus-visible{outline-offset:-1px}\n.dtc-task:has(.dtc-chip.warn){border-left:3px solid color-mix(in oklab,var(--dtc-warn) 78%,var(--dtc-edge));padding-left:6px;background:color-mix(in oklab,var(--dtc-warn) 5%,transparent)}\n.dtc-task:has(.dtc-chip.warn):hover{background:color-mix(in oklab,var(--dtc-warn) 9%,transparent)}\n.dtc-taskMain{min-width:0;display:flex;align-items:center;gap:7px}\n.dtc-id{font-family:var(--dtc-mono);font-size:9.5px;color:var(--dtc-dim2);flex:none;background:var(--dtc-card3);padding:1px 5px;border-radius:4px;line-height:1.4}\n.dtc-taskSubject{font-size:11.5px;color:var(--dtc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}\n.dtc-taskSide{display:flex;align-items:center;gap:6px;flex:none}\n.dtc-ownerPill{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dtc-edge);background:var(--dtc-card2);border-radius:999px;padding:0 8px 0 3px;height:20px;font-size:10px;color:var(--dtc-dim);max-width:130px;white-space:nowrap}\n.dtc-ownerPill .dtc-avatarMini{width:15px;height:15px;font-size:8px;margin:0;border-width:0;box-shadow:none}\n.dtc-ownerPill span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dtc-ownerPill.unowned{border-style:dashed;background:transparent;color:var(--dtc-dim2);padding:0 7px}\n.dtc-chip{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:6px;background:var(--dtc-card2);border:1px solid var(--dtc-edge);font-size:9.5px;font-weight:650;color:var(--dtc-dim);white-space:nowrap}\n.dtc-chip.ok{color:var(--dtc-ok);border-color:color-mix(in oklab,var(--dtc-ok) 30%,transparent);background:color-mix(in oklab,var(--dtc-ok) 8%,transparent)}\n.dtc-chip.warn{color:var(--dtc-warn);border-color:color-mix(in oklab,var(--dtc-warn) 30%,transparent);background:color-mix(in oklab,var(--dtc-warn) 8%,transparent)}\n.dtc-detailBtn{flex:none;width:18px;height:18px;border-radius:5px;border:0;background:transparent;color:var(--dtc-dim2);font-size:10px;line-height:1;cursor:pointer;opacity:.55;transition:opacity .15s ease,background-color .15s ease,color .15s ease}\n.dtc-task:hover .dtc-detailBtn{opacity:1}\n.dtc-detailBtn:hover{background:var(--dtc-card3);color:var(--dtc-text)}\n.dtc-detailBtn.open{transform:rotate(180deg);color:var(--dtc-brand);opacity:1}\n.dtc-taskDetail{grid-column:1/-1;margin:3px 0 2px;padding:8px 10px;border-radius:8px;background:var(--dtc-card2);border:1px solid var(--dtc-edge);font-size:11px;line-height:1.6;color:var(--dtc-dim);white-space:pre-wrap;word-break:break-word}\n.dtc-taskRow{margin-top:4px;color:var(--dtc-dim2);font-size:10.5px}\n\n/* --- 5. 右侧流式区 ------------------------------------------------------- */\n.dtc-stream{min-height:0;display:flex;flex-direction:column;background:var(--dtc-bg);position:relative}\n.dtc-streamHead{display:flex;align-items:center;gap:9px;padding:0 20px;height:52px;flex:none;border-bottom:1px solid var(--dtc-edge);background:color-mix(in oklab,var(--dtc-card) 62%,var(--dtc-bg))}\n.dtc-backOverviewBtn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border-radius:8px;border:1px solid var(--dtc-edge);background:var(--dtc-card);color:var(--dtc-dim);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;flex:none;transition:background-color .14s ease,color .14s ease,border-color .14s ease}\n.dtc-backOverviewBtn:hover{background:var(--dtc-card2);color:var(--dtc-text);border-color:var(--dtc-edge2)}\n.dtc-kind{font-size:9.5px;font-weight:700;letter-spacing:.05em;padding:2px 7px;border-radius:6px;background:color-mix(in oklab,var(--dtc-brand) 10%,transparent);border:1px solid color-mix(in oklab,var(--dtc-brand) 22%,transparent);color:var(--dtc-brand);text-transform:uppercase;flex:none}\n.dtc-stitle{font-size:14px;font-weight:700;letter-spacing:-.01em;color:var(--dtc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}\n.dtc-smeta{margin-left:auto;font-size:11px;color:var(--dtc-dim2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%;font-variant-numeric:tabular-nums}\n\n/* 任务书 */\n.dtc-missionCard{margin:12px 20px 0;padding:10px 14px;border-radius:12px;background:linear-gradient(180deg,color-mix(in oklab,var(--dtc-brand) 6%,var(--dtc-card)),var(--dtc-card));border:1px solid color-mix(in oklab,var(--dtc-brand) 18%,var(--dtc-edge));border-left:3px solid var(--dtc-brand);box-shadow:var(--dtc-shadow-sm);display:flex;flex-direction:column;gap:6px}\n.dtc-missionHead{display:flex;align-items:flex-start;gap:8px}\n.dtc-missionIcon{font-size:12px;line-height:1.5;flex:none}\n.dtc-missionTitle{font-size:12px;font-weight:600;color:var(--dtc-text);line-height:1.5;min-width:0}\n.dtc-missionDesc{font-size:12px;font-weight:600;color:var(--dtc-text);line-height:1.5}\n.dtc-missionToggle{border:0;background:none;padding:0;color:var(--dtc-brand);font-size:10.5px;font-family:inherit;font-weight:650;cursor:pointer;margin-left:auto;flex:none;line-height:1.5}\n.dtc-missionToggle:hover{text-decoration:underline}\n.dtc-missionPrompt{margin:2px 0 0;padding:9px 11px;border-radius:8px;background:var(--dtc-card2);border:1px solid var(--dtc-edge);font-family:var(--dtc-mono);font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow-y:auto;color:var(--dtc-dim);margin-left:0}\n\n/* 导读栏 */\n.dtc-sectBar{flex:none;display:flex;align-items:center;gap:8px;padding:0 20px;height:34px;border-bottom:1px solid var(--dtc-edge);background:color-mix(in oklab,var(--dtc-card2) 45%,var(--dtc-bg));font-size:10.5px;color:var(--dtc-dim2);position:sticky;top:0;z-index:5}\n.dtc-sectBar b{font-size:11.5px;font-weight:700;color:var(--dtc-text);letter-spacing:-.005em}\n.dtc-sectNum{background:var(--dtc-card3);border:1px solid var(--dtc-edge);border-radius:6px;padding:0 6px;font-size:9.5px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dtc-dim);font-weight:650}\n.dtc-guide{flex-wrap:wrap;row-gap:4px}\n.dtc-guideText{margin-left:auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap;color:var(--dtc-dim2);font-size:10.5px}\n.dtc-guideItem{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}\n.dtc-guideNo{width:15px;height:15px;border-radius:99px;display:grid;place-items:center;color:var(--dtc-brand);background:color-mix(in oklab,var(--dtc-brand) 10%,transparent);font-weight:700;font-size:9.5px;line-height:1}\n.dtc-stream:has(> .dtc-feed > .dtc-cockpit) .dtc-guideText{display:none}\n.dtc-stream:has(> .dtc-feed > .dtc-cockpit) .dtc-sectBar b{letter-spacing:0}\n\n/* --- 6. 消息流 ----------------------------------------------------------- */\n.dtc-feed{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:20px 24px 80px;display:flex;flex-direction:column;gap:18px}\n.dtc-feed>*{width:100%;max-width:860px;margin:0 auto}\n.dtc-feed>.dtc-cockpit{max-width:none;margin:0;padding:2px 0 8px}\n\n.dtc-talk{display:flex;width:100%;gap:10px;align-items:flex-start}\n.dtc-talk.out{flex-direction:row;justify-content:flex-start}\n.dtc-talk.in{flex-direction:row-reverse;justify-content:flex-start}\n.dtc-talk.dtc-in{animation:dtcRise .28s cubic-bezier(.2,.7,.3,1) both}\n@keyframes dtcRise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}\n.dtc-talkAvatar{width:28px;height:28px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:11px;font-weight:700;color:#fff;margin-top:2px;box-shadow:0 0 0 2px color-mix(in oklab,var(--dtc-bg) 90%,transparent),0 2px 6px -2px rgba(15,23,42,.3)}\n.dtc-talkBody{flex:0 1 auto;min-width:0;max-width:84%;display:flex;flex-direction:column;gap:5px}\n.dtc-talk.out .dtc-talkBody{align-items:flex-start;margin-right:auto;margin-left:0}\n.dtc-talk.in .dtc-talkBody{align-items:flex-end;margin-left:auto;margin-right:0}\n.dtc-talkLabel{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:650;color:var(--dtc-dim2)}\n.dtc-talk.out .dtc-talkLabel{justify-content:flex-start}\n.dtc-talk.in .dtc-talkLabel{justify-content:flex-end;flex-direction:row}\n.dtc-talkLabel b{font-size:11.5px;font-weight:650;color:var(--dtc-text)}\n.dtc-talk.out .dtc-talkLabel b{color:var(--dtc-brand)}\n.dtc-roleTag{font-size:9.5px;font-weight:650;letter-spacing:.02em;color:var(--dtc-brand);border:1px solid color-mix(in oklab,var(--dtc-brand) 26%,transparent);background:color-mix(in oklab,var(--dtc-brand) 8%,transparent);border-radius:5px;padding:0 5px;line-height:16px}\n.dtc-roleTag.reply{color:var(--dtc-ok);border-color:color-mix(in oklab,var(--dtc-ok) 26%,transparent);background:color-mix(in oklab,var(--dtc-ok) 8%,transparent)}\n\n/* 气泡 */\n.dtc-bubble{width:auto;max-width:100%;border-radius:16px;padding:11px 15px;font-size:13px;line-height:1.7;word-break:break-word;box-shadow:var(--dtc-shadow-sm)}\n.dtc-bubble b{font-weight:650;color:var(--dtc-text)}\n.dtc-bubble.out{background:linear-gradient(180deg,color-mix(in oklab,var(--dtc-brand) 7%,var(--dtc-card)),color-mix(in oklab,var(--dtc-brand) 3%,var(--dtc-card)));border:1px solid color-mix(in oklab,var(--dtc-brand) 18%,transparent);border-top-left-radius:5px}\n.dtc-bubble.in{background:var(--dtc-card);border:1px solid var(--dtc-edge);border-top-right-radius:5px;text-align:left;box-shadow:inset 0 1px 0 light-dark(rgba(15,23,42,.06),rgba(255,255,255,.07)),var(--dtc-shadow-sm)}\n.dtc-bubble.clamp{max-height:160px;overflow:hidden;position:relative}\n\n/* 富文本 */\n.dtc-inlineCode{font-family:var(--dtc-mono);font-size:11.5px;background:color-mix(in oklab,var(--dtc-card3) 80%,transparent);padding:1px 5px;border-radius:5px;border:1px solid var(--dtc-edge);color:var(--dtc-text)}\n.dtc-codeBlock{margin:9px 0;padding:11px 13px;border-radius:10px;background:linear-gradient(180deg,#111827,#0b1020);color:#e6edf3;font-family:var(--dtc-mono);font-size:11.5px;line-height:1.6;overflow-x:auto;border:1px solid rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}\n.dtc-codeBlock code{font-family:inherit;background:none;padding:0;border:0;color:inherit}\n.dtc-passMark{color:var(--dtc-ok);font-weight:700;display:inline-block;margin-right:2px}\n\n/* Markdown 渲染（气泡内的 .dtc-md 作用域；颜色一律走 --dtc-* 令牌） */\n.dtc-md{overflow-wrap:anywhere}\n.dtc-md>:first-child{margin-top:0}\n.dtc-md>:last-child{margin-bottom:0}\n.dtc-md p{margin:0 0 7px;line-height:1.7}\n.dtc-md h1,.dtc-md h2{font-size:15px;font-weight:700;line-height:1.4;margin:15px 0 7px;color:var(--dtc-text);letter-spacing:-.01em}\n.dtc-md h3,.dtc-md h4{font-size:13.5px;font-weight:650;line-height:1.45;margin:12px 0 6px;color:var(--dtc-text)}\n.dtc-md h1+p,.dtc-md h2+p,.dtc-md h3+p,.dtc-md h4+p{margin-top:0}\n.dtc-md strong,.dtc-md b{font-weight:650;color:var(--dtc-text)}\n.dtc-md em,.dtc-md i{font-style:italic}\n.dtc-md del{color:var(--dtc-dim2);text-decoration:line-through}\n.dtc-md ul,.dtc-md ol{margin:0 0 7px;padding-left:20px}\n.dtc-md li{margin:2px 0;line-height:1.62}\n.dtc-md li>ul,.dtc-md li>ol{margin:2px 0;padding-left:16px}\n.dtc-md blockquote{margin:0 0 8px;padding:3px 0 3px 10px;border-left:3px solid color-mix(in oklab,var(--dtc-brand) 34%,var(--dtc-edge));color:var(--dtc-dim);font-size:12.5px}\n.dtc-md blockquote>:first-child{margin-top:0}\n.dtc-md blockquote>:last-child{margin-bottom:0}\n.dtc-md .dtc-mdScroll{max-width:100%;overflow-x:auto;margin:0 0 8px;overscroll-behavior-x:contain}\n.dtc-md table{border-collapse:collapse;width:100%;min-width:max-content;font-size:12px;line-height:1.55}\n.dtc-md th,.dtc-md td{border:1px solid color-mix(in oklab,var(--dtc-edge) 85%,transparent);padding:4px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}\n.dtc-md th{background:color-mix(in oklab,var(--dtc-card3) 55%,transparent);font-weight:650;color:var(--dtc-text);white-space:nowrap}\n.dtc-md tbody tr:nth-child(even) td{background:color-mix(in oklab,var(--dtc-card2) 45%,transparent)}\n.dtc-md a{color:var(--dtc-brand);text-decoration:none;border-bottom:1px solid color-mix(in oklab,var(--dtc-brand) 32%,transparent)}\n.dtc-md a:hover{text-decoration:underline;border-bottom-color:var(--dtc-brand)}\n.dtc-md hr{border:0;border-top:1px solid var(--dtc-edge);margin:12px 0}\n.dtc-md pre.dtc-codeBlock{margin:9px 0}\n.dtc-md code{overflow-wrap:anywhere}\n.dtc-md br{line-height:1.7}\n\n/* 执行步骤 */\n.dtc-steps{margin-top:6px;border:1px solid var(--dtc-edge);border-radius:12px;background:color-mix(in oklab,var(--dtc-card2) 62%,var(--dtc-card));padding:9px 12px 6px;max-width:100%;width:100%;min-width:min(100%,360px);box-shadow:var(--dtc-shadow-sm)}\n.dtc-talk.out .dtc-steps{border-top-left-radius:5px}\n.dtc-talk.in .dtc-steps{border-top-right-radius:5px}\n.dtc-stepsHead{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--dtc-dim2);margin-bottom:6px;display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}\n.dtc-stepList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}\n.dtc-stepItem{position:relative;z-index:0;display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:9px;align-items:start;padding:6px 0;border-bottom:1px solid color-mix(in oklab,var(--dtc-edge) 60%,transparent)}\n.dtc-stepItem:before{content:\"\";position:absolute;left:9.5px;top:27px;bottom:-7px;width:1px;z-index:-1;pointer-events:none;background:color-mix(in oklab,var(--dtc-edge) 90%,transparent)}\n.dtc-stepItem:last-child{border-bottom:0}\n.dtc-stepItem:last-child:before{display:none}\n.dtc-stepNo{width:20px;height:20px;border-radius:50%;background:var(--dtc-card3);border:1px solid var(--dtc-edge);color:var(--dtc-dim2);font-size:9.5px;font-weight:700;display:grid;place-items:center;font-variant-numeric:tabular-nums;margin-top:1px}\n.dtc-stepItem.ok .dtc-stepNo{background:color-mix(in oklab,var(--dtc-ok) 12%,color-mix(in oklab,var(--dtc-card2) 62%,var(--dtc-card)));border-color:color-mix(in oklab,var(--dtc-ok) 34%,transparent);color:var(--dtc-ok)}\n.dtc-stepItem.bad .dtc-stepNo{background:color-mix(in oklab,var(--dtc-bad) 12%,color-mix(in oklab,var(--dtc-card2) 62%,var(--dtc-card)));border-color:color-mix(in oklab,var(--dtc-bad) 34%,transparent);color:var(--dtc-bad)}\n.dtc-stepMain{min-width:0}\n.dtc-stepTitle{font-size:12px;line-height:1.5;font-weight:550;color:var(--dtc-text);word-break:break-word}\n.dtc-stepMeta{font-size:10px;color:var(--dtc-dim2);margin-top:2px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}\n.dtc-stepItem.ok .dtc-stepMeta{color:color-mix(in oklab,var(--dtc-ok) 80%,var(--dtc-dim2))}\n.dtc-stepItem.bad .dtc-stepMeta{color:var(--dtc-bad)}\n.dtc-stepFold{grid-column:2/-1}\n.dtc-stepMore{list-style:none;cursor:pointer;font-size:10px;line-height:16px;color:var(--dtc-dim2);border:1px solid var(--dtc-edge);border-radius:6px;padding:0 7px;background:var(--dtc-card);white-space:nowrap;transition:color .14s ease,border-color .14s ease}\n.dtc-stepMore::-webkit-details-marker{display:none}\n.dtc-stepMore:hover{color:var(--dtc-brand);border-color:color-mix(in oklab,var(--dtc-brand) 40%,var(--dtc-edge))}\n.dtc-stepFold[open]>.dtc-stepMore{color:var(--dtc-brand)}\n.dtc-stepFold>pre{grid-column:2/-1;margin:6px 0 0;border-radius:8px}\n.dtc-pre{border:1px solid var(--dtc-edge);background:color-mix(in oklab,var(--dtc-card) 55%,var(--dtc-bg));font-family:var(--dtc-mono);font-size:10.5px;line-height:1.6;padding:9px 11px;max-height:280px;overflow:auto;border-radius:8px;white-space:pre-wrap;word-break:break-word;color:var(--dtc-text)}\n\n/* 思考过程 */\n.dtc-thinkFold{margin-top:6px;border-top:1px dashed var(--dtc-edge);padding-top:7px}\n.dtc-thinkFold>summary{font-size:10.5px;font-weight:600;color:var(--dtc-dim2);cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:5px;transition:color .14s ease}\n.dtc-thinkFold>summary:before{content:\"\\25B8\";font-size:9px;line-height:1;transition:transform .18s ease}\n.dtc-thinkFold[open]>summary:before{transform:rotate(90deg)}\n.dtc-thinkFold>summary::-webkit-details-marker{display:none}\n.dtc-thinkFold>summary:hover{color:var(--dtc-brand)}\n.dtc-thinkText{font-size:11px;border-left:2px solid color-mix(in oklab,var(--dtc-brand) 32%,var(--dtc-edge));background:color-mix(in oklab,var(--dtc-card2) 70%,transparent);padding:6px 10px;margin-top:6px;border-radius:0 8px 8px 0;color:var(--dtc-dim);line-height:1.6;white-space:pre-wrap}\n\n/* --- 7. 团队指挥中枢 ----------------------------------------------------- */\n.dtc-cockpit{display:flex;flex-direction:column;gap:20px;min-width:0}\n.dtc-cockpitHero{position:relative;isolation:isolate;overflow:hidden;padding:22px 24px;border-radius:18px;border:1px solid color-mix(in oklab,var(--dtc-brand) 16%,var(--dtc-edge));background:linear-gradient(180deg,color-mix(in oklab,var(--dtc-brand) 5%,var(--dtc-card)),var(--dtc-card));box-shadow:var(--dtc-shadow-md);display:flex;flex-direction:column;gap:10px}\n.dtc-cockpitHero:before{content:\"\";position:absolute;left:-10%;right:-10%;top:-70%;height:210%;z-index:-1;pointer-events:none;background:radial-gradient(58% 46% at 14% 26%,color-mix(in oklab,var(--dtc-brand) 20%,transparent),transparent 70%),radial-gradient(48% 40% at 92% 18%,color-mix(in oklab,#8b5cf6 14%,transparent),transparent 72%)}\n.dtc-cockpitHero:after{content:\"\";position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:.26;background-image:linear-gradient(90deg,color-mix(in oklab,var(--dtc-text) 5%,transparent) 1px,transparent 1px),linear-gradient(180deg,color-mix(in oklab,var(--dtc-text) 5%,transparent) 1px,transparent 1px);background-size:28px 28px;mask-image:radial-gradient(120% 100% at 50% 0%,#000 15%,transparent 70%);-webkit-mask-image:radial-gradient(120% 100% at 50% 0%,#000 15%,transparent 70%)}\n.dtc-cockpitBadgeRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.dtc-cockpitTag{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--dtc-brand);background:color-mix(in oklab,var(--dtc-brand) 10%,transparent);border:1px solid color-mix(in oklab,var(--dtc-brand) 22%,transparent);padding:3px 10px;border-radius:999px;line-height:1.5}\n.dtc-cockpitStateTag{font-size:10px;font-weight:650;color:var(--dtc-ok);background:color-mix(in oklab,var(--dtc-ok) 9%,transparent);border:1px solid color-mix(in oklab,var(--dtc-ok) 24%,transparent);padding:3px 10px;border-radius:999px;display:inline-flex;align-items:center;gap:6px;line-height:1.5}\n.dtc-cockpitTitle{font-size:22px;font-weight:750;color:var(--dtc-text);letter-spacing:-.02em;line-height:1.32;text-wrap:balance}\n.dtc-cockpitMeta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dtc-dim);flex-wrap:wrap}\n.dtc-cockpitMeta span{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 9px;border-radius:999px;background:color-mix(in oklab,var(--dtc-card) 70%,transparent);border:1px solid var(--dtc-edge);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n\n/* 指标卡 */\n.dtc-metricsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}\n.dtc-metricCard{padding:14px 16px;border-radius:14px;background:var(--dtc-card);border:1px solid var(--dtc-edge);box-shadow:var(--dtc-shadow-sm);display:flex;flex-direction:column;gap:4px;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}\n.dtc-metricCard:hover{transform:translateY(-2px);border-color:var(--dtc-edge2);box-shadow:var(--dtc-shadow-md)}\n.dtc-metricHead{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.dtc-metricLabel{font-size:10px;font-weight:700;color:var(--dtc-dim2);letter-spacing:.06em}\n.dtc-metricIcon{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-size:12px;background:var(--dtc-card2);border:1px solid var(--dtc-edge);color:var(--dtc-brand);flex:none}\n.dtc-metricVal{font-size:30px;font-weight:750;color:var(--dtc-text);font-variant-numeric:tabular-nums;letter-spacing:-.03em;line-height:1.15;margin-top:2px}\n.dtc-metricSub{font-size:10.5px;color:var(--dtc-dim2)}\n\n/* 区块标题 */\n.dtc-sectionHead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:4px}\n.dtc-sectionTitle{font-size:13px;font-weight:700;color:var(--dtc-text);display:flex;align-items:center;gap:7px;letter-spacing:-.005em}\n.dtc-sectionTitle:before{content:\"\";width:3px;height:13px;border-radius:2px;background:var(--dtc-brand);flex:none}\n.dtc-sectionSub{font-size:10.5px;color:var(--dtc-dim2);text-align:right}\n\n/* 智能体集群卡 */\n.dtc-fleetGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}\n.dtc-fleetCard{padding:14px 16px;border-radius:14px;background:var(--dtc-card);border:1px solid var(--dtc-edge);box-shadow:var(--dtc-shadow-sm);display:flex;flex-direction:column;gap:10px;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}\n.dtc-fleetCard:hover{transform:translateY(-2px);border-color:color-mix(in oklab,var(--dtc-brand) 28%,var(--dtc-edge));box-shadow:var(--dtc-shadow-md)}\n.dtc-fleetCardHead{display:flex;align-items:center;gap:9px}\n.dtc-fleetCardHead .dtc-avatar{width:30px;height:30px;font-size:12px}\n.dtc-fleetNameRow{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;align-items:flex-start}\n.dtc-fleetName{font-size:13px;font-weight:700;color:var(--dtc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;letter-spacing:-.005em}\n.dtc-fleetRoleTag{align-self:flex-start;font-size:9.5px;font-weight:650;padding:1px 6px;border-radius:5px;background:var(--dtc-card2);border:1px solid var(--dtc-edge);color:var(--dtc-dim)}\n.dtc-fleetRoleTag.lead{background:color-mix(in oklab,var(--dtc-brand) 10%,transparent);border-color:color-mix(in oklab,var(--dtc-brand) 20%,transparent);color:var(--dtc-brand)}\n.dtc-fleetActivity{font-size:11px;color:var(--dtc-dim);display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 9px;border-radius:9px;background:var(--dtc-card2);border:1px solid transparent;min-width:0}\n.dtc-fleetActivity.busy{color:var(--dtc-ok);background:color-mix(in oklab,var(--dtc-ok) 8%,var(--dtc-card2));font-weight:550}\n.dtc-fleetStats{display:flex;align-items:center;gap:12px;font-size:10.5px;color:var(--dtc-dim2);font-variant-numeric:tabular-nums}\n.dtc-fleetStats b{color:var(--dtc-text);font-weight:700;font-size:11px}\n.dtc-fleetMission{font-size:11px;color:var(--dtc-dim2);line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding-left:8px;border-left:2px solid color-mix(in oklab,var(--dtc-brand) 26%,transparent)}\n.dtc-fleetBtn{margin-top:auto;display:inline-flex;align-items:center;justify-content:center;gap:5px;width:100%;height:30px;padding:0 10px;border-radius:9px;border:1px solid color-mix(in oklab,var(--dtc-brand) 22%,transparent);background:color-mix(in oklab,var(--dtc-brand) 7%,transparent);color:var(--dtc-brand);font-size:11px;font-weight:650;cursor:pointer;font-family:inherit;transition:background-color .15s ease,color .15s ease,border-color .15s ease,box-shadow .15s ease,transform .15s ease}\n.dtc-fleetBtn:hover{background:var(--dtc-brand);color:var(--dtc-card);border-color:transparent;box-shadow:var(--dtc-shadow-glow)}\n.dtc-fleetBtn:active{transform:translateY(1px)}\n\n/* 任务矩阵 */\n.dtc-cockpitTasks{padding:14px 16px;border-radius:14px;background:var(--dtc-card);border:1px solid var(--dtc-edge);display:flex;flex-direction:column;gap:10px}\n.dtc-tasksGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}\n.dtc-taskCardItem{padding:11px 12px;border-radius:10px;background:var(--dtc-card2);border:1px solid var(--dtc-edge);cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:transform .14s ease,background-color .14s ease,border-color .14s ease,box-shadow .14s ease}\n.dtc-taskCardItem:hover{border-color:color-mix(in oklab,var(--dtc-brand) 32%,var(--dtc-edge));background:var(--dtc-card);transform:translateY(-1px);box-shadow:var(--dtc-shadow-sm)}\n.dtc-taskCardItem.is-unassigned{cursor:default}\n.dtc-taskCardItem.is-unassigned:hover{transform:none;border-color:var(--dtc-edge);background:var(--dtc-card2);box-shadow:none}\n.dtc-taskCardHead{display:flex;align-items:center;gap:7px;min-width:0}\n.dtc-taskCardTitle{font-size:11.5px;font-weight:600;color:var(--dtc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}\n.dtc-taskCardDesc{font-size:10.5px;color:var(--dtc-dim2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.dtc-taskCardFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}\n\n/* 自动流程 */\n.dtc-autoFlow{padding:14px 16px;border-radius:14px;background:color-mix(in oklab,var(--dtc-brand) 4%,var(--dtc-card));border:1px dashed color-mix(in oklab,var(--dtc-brand) 28%,var(--dtc-edge));display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n.dtc-flowStep{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:var(--dtc-text)}\n.dtc-flowArrow{color:var(--dtc-brand);font-size:13px;line-height:1}\n\n/* --- 8. 杂项：事件、空态、跳转、骨架 ------------------------------------ */\n.dtc-event{align-self:center;display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dtc-dim2);padding:3px 12px;border-radius:999px;border:1px dashed var(--dtc-edge);background:var(--dtc-card2);max-width:100%}\n.dtc-truncHint{align-self:center;width:auto!important;font-size:11px;color:var(--dtc-dim2);padding:4px 12px;border-radius:999px;border:1px dashed var(--dtc-edge);background:var(--dtc-card2);text-align:center}\n.dtc-memberRoleTag{flex:none;font-size:9.5px;font-weight:650;padding:0 5px;border-radius:6px;background:color-mix(in oklab,var(--dtc-brand) 10%,transparent);border:1px solid color-mix(in oklab,var(--dtc-brand) 22%,transparent);color:var(--dtc-brand);line-height:15px}\n.dtc-subSteps{margin-top:6px;padding:6px 8px;border-radius:6px;background:color-mix(in oklab,var(--dtc-card2) 80%,transparent);border:1px solid var(--dtc-edge);font-size:10.5px;display:flex;flex-direction:column;gap:3px}\n.dtc-subStep{display:flex;align-items:center;gap:6px;color:var(--dtc-dim);word-break:break-word}\n.dtc-subStep.bad{color:var(--dtc-bad)}\n.dtc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:48px 20px;text-align:center;color:var(--dtc-dim)}\n.dtc-emptyIcon{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;font-size:20px;background:linear-gradient(180deg,color-mix(in oklab,var(--dtc-brand) 10%,var(--dtc-card)),var(--dtc-card));border:1px solid var(--dtc-edge);color:var(--dtc-brand);box-shadow:var(--dtc-shadow-sm)}\n.dtc-empty h4{margin:0;font-size:14px;font-weight:700;color:var(--dtc-text)}\n.dtc-empty p{margin:0;font-size:11.5px;max-width:420px;line-height:1.7;color:var(--dtc-dim2)}\n.dtc-jump{position:absolute;right:24px;bottom:22px;z-index:20;display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 13px;border-radius:999px;border:1px solid var(--dtc-edge);background:color-mix(in oklab,var(--dtc-card) 92%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:var(--dtc-text);font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;box-shadow:var(--dtc-shadow-md);transition:transform .15s ease,border-color .15s ease,color .15s ease}\n.dtc-jump:hover{transform:translateY(-1px);border-color:color-mix(in oklab,var(--dtc-brand) 40%,var(--dtc-edge));color:var(--dtc-brand)}\n\n/* 骨架屏 */\n.dtc-skelRow{display:flex;align-items:center;gap:9px;padding:8px}\n.dtc-skelDot{width:26px;height:26px;border-radius:50%;flex:none;background:linear-gradient(90deg,var(--dtc-card3) 0%,var(--dtc-card2) 50%,var(--dtc-card3) 100%);background-size:200% 100%;animation:dtcShimmer 1.6s linear infinite}\n.dtc-skelCol{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}\n.dtc-skelLine{height:8px;border-radius:99px;background:linear-gradient(90deg,var(--dtc-card3) 0%,var(--dtc-card2) 50%,var(--dtc-card3) 100%);background-size:200% 100%;animation:dtcShimmer 1.6s linear infinite}\n.dtc-skelLine.short{width:45%}\n.dtc-skelBlock{height:64px;border-radius:12px;background:linear-gradient(90deg,var(--dtc-card) 0%,var(--dtc-card2) 50%,var(--dtc-card) 100%);border:1px solid var(--dtc-edge);background-size:200% 100%;animation:dtcShimmer 1.6s linear infinite}\n@keyframes dtcShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}\n\n/* --- 9. 滚动条 / 响应式 / 动效降级 -------------------------------------- */\n.dtc-root ::-webkit-scrollbar{width:8px;height:8px}\n.dtc-root ::-webkit-scrollbar-track{background:transparent}\n.dtc-root ::-webkit-scrollbar-thumb{background:var(--dtc-edge2);border:2px solid transparent;background-clip:content-box;border-radius:99px}\n.dtc-root ::-webkit-scrollbar-thumb:hover{background:var(--dtc-dim2);border:2px solid transparent;background-clip:content-box}\n\n@container dtc (max-width:900px){\n  .dtc-main{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}\n  .dtc-stream{min-width:0}\n  .dtc-rail{flex-direction:row;align-items:flex-start;gap:12px;overflow:auto;max-height:34vh;border-bottom:1px solid var(--dtc-edge);border-right:0;padding:12px}\n  .dtc-overviewBtn{width:auto;min-width:196px;flex:none}\n  .dtc-railSection{flex:none;width:260px}\n  .dtc-railSection+.dtc-railSection{border-top:0;padding-top:0;border-left:1px solid color-mix(in oklab,var(--dtc-edge) 92%,transparent);padding-left:12px}\n  .dtc-req{min-width:0;flex:1}\n  .dtc-feed{padding:16px 16px 56px}\n  .dtc-top{padding:0 12px;gap:8px}\n  .dtc-team{max-width:180px}\n  .dtc-smeta{display:none}\n  .dtc-talkBody{max-width:90%}\n  .dtc-metricsGrid{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .dtc-cockpitHero{padding:18px}\n  .dtc-cockpitTitle{font-size:19px}\n}\n@container dtc (max-width:600px){\n  .dtc-brandBadge{display:none}\n  .dtc-clock{display:none}\n  .dtc-railHead{display:none}\n  .dtc-guideText{display:none}\n  .dtc-talkBody{max-width:100%}\n  .dtc-metricsGrid{grid-template-columns:1fr}\n  .dtc-cockpitTitle{font-size:18px}\n  .dtc-overviewBtn{width:auto;min-width:176px}\n  .dtc-brandTitle{font-size:13px}\n  .dtc-team{max-width:140px}\n  .dtc-brand{min-width:0}\n  .dtc-brandTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .dtc-railSection{width:240px}\n  .dtc-missionCard{margin:10px 12px 0}\n  .dtc-sectBar{padding:0 12px}\n}\n@media (prefers-reduced-motion:reduce){\n  .dtc-root *,.dtc-root *:before,.dtc-root *:after{animation:none!important;transition:none!important}\n}";

    function ensureStyle() {
      if (typeof document === "undefined") return null;
      var existing = document.querySelector("style[data-team-console]");
      if (existing) {
        existing.textContent = CSS;
        return existing;
      }
      var tag = document.createElement("style");
      tag.setAttribute("data-team-console", "1");
      tag.textContent = CSS;
      if (document.head) document.head.appendChild(tag);
      return tag;
    }

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
      if (parts.length === 0) return text.slice(0, 1).toUpperCase();
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function phaseLabel(phase) {
      if (phase === "active") return "活跃";
      if (phase === "provisioning") return "准备中";
      if (phase === "failed") return "失败";
      if (phase === "inactive") return "空闲";
      return phase || "";
    }

    function duration(item) {
      if (!item || !item.time || !item.resultTime) return "";
      var ms = item.resultTime - item.time;
      if (ms < 0) return "";
      if (ms < 1000) return ms + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }

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

    async function getJson(url, timeoutMs) {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = controller && timeoutMs ? setTimeout(function () { try { controller.abort(); } catch (e) {} }, timeoutMs) : null;
      try {
        var response = await fetch(url, controller ? { cache: "no-store", signal: controller.signal } : { cache: "no-store" });
        if (!response.ok) {
          var err = new Error("HTTP " + response.status);
          err.status = response.status;
          throw err;
        }
        return await response.json();
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function findApi() {
      for (var i = 0; i < API_PORTS.length; i += 1) {
        var base = "http://127.0.0.1:" + API_PORTS[i];
        try {
          var data = await getJson(base + "/api/health", 700);
          if (data && data.ok) return base;
        } catch (error) {}
      }
      return null;
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

    function avatarStyle(name) {
      var hash = 0;
      var text = String(name || "?");
      for (var i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
      return { background: "linear-gradient(135deg, hsl(" + hash + " 62% 46%), hsl(" + ((hash + 36) % 360) + " 58% 38%))" };
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

    /* >>> md-react —— 面板端序列化：同一棵 token 树 → React 节点（只拼节点，不做 HTML 注入）
       token 里的字符串是已转义文本，这里用 mdUnesc() 还原成真实文本，交给 React 自己转义。 */
    function mdUnesc(value) {
      return String(value == null ? "" : value)
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    }

    function mdInlineNodes(tokens) {
      var nodes = [];
      tokens.forEach(function (tk, idx) {
        var key = "i" + idx;
        if (tk.k === "text") { nodes.push(mdUnesc(tk.v)); return; }
        if (tk.k === "br") { nodes.push(h("br", { key: key })); return; }
        if (tk.k === "pass") { nodes.push(h("span", { key: key, className: "dtc-passMark" }, "✓")); nodes.push(" "); return; }
        if (tk.k === "code") { nodes.push(h("code", { key: key, className: "dtc-inlineCode" }, mdUnesc(tk.v))); return; }
        if (tk.k === "b") { nodes.push(h("b", { key: key }, mdInlineNodes(tk.c))); return; }
        if (tk.k === "i") { nodes.push(h("i", { key: key }, mdInlineNodes(tk.c))); return; }
        if (tk.k === "del") { nodes.push(h("del", { key: key }, mdInlineNodes(tk.c))); return; }
        if (tk.k === "a") { nodes.push(h("a", { key: key, href: mdUnesc(tk.href), target: "_blank", rel: "noopener noreferrer" }, mdInlineNodes(tk.c))); }
      });
      return nodes;
    }

    function mdListNodes(block, key) {
      var tag = block.ordered ? "ol" : "ul";
      return h(tag, { key: key }, block.tree.map(function (node, idx) {
        var kids = node.kids.length ? mdListNodes({ ordered: block.ordered, tree: node.kids }, "k") : null;
        return h("li", { key: "l" + idx }, [mdInlineNodes(node.inl), kids]);
      }));
    }

    function mdBlockNodes(blocks) {
      return blocks.map(function (b, idx) {
        var key = "b" + idx;
        if (b.t === "p") return h("p", { key: key }, mdInlineNodes(b.inl));
        if (b.t === "h") return h("h" + b.level, { key: key }, mdInlineNodes(b.inl));
        if (b.t === "hr") return h("hr", { key: key });
        if (b.t === "quote") return h("blockquote", { key: key }, mdBlockNodes(b.blocks));
        if (b.t === "list") return mdListNodes(b, key);
        if (b.t === "code") return h("pre", { key: key, className: "dtc-codeBlock" }, h("code", { className: b.lang ? "language-" + mdUnesc(b.lang) : undefined }, mdUnesc(b.text)));
        if (b.t === "table") {
          return h("div", { key: key, className: "dtc-mdScroll" }, h("table", null, [
            h("thead", { key: "h" }, h("tr", null, b.head.map(function (cell, c) {
              return h("th", { key: "h" + c }, mdInlineNodes(cell));
            }))),
            h("tbody", { key: "b" }, b.rows.map(function (row, r) {
              return h("tr", { key: "r" + r }, row.map(function (cell, c) {
                return h("td", { key: "c" + c }, mdInlineNodes(cell));
              }));
            }))
          ]));
        }
        return null;
      });
    }

    function renderBubbleText(raw) {
      var blocks = mdParse(raw);
      if (!blocks.length) return null;
      return mdBlockNodes(blocks);
    }
    /* <<< md-react */

    function MemberChild(props) {
      var member = props.member;
      var activity = member.activity || {};
      var busy = activity.kind === "tool" || activity.kind === "thinking";
      var line = activity.label || "空闲";
      if (activity.lastTime) line += " · " + ago(activity.lastTime);
      return h("button", {
        type: "button",
        className: "dtc-member" + (props.active ? " is-on" : ""),
        title: (member.assignment && member.assignment.description) || member.description || member.name,
        onClick: props.onSelect
      }, [
        h("span", { key: "a", className: "dtc-avatar", style: avatarStyle(member.name) }, initials(member.name)),
        h("span", { key: "b", className: "dtc-memberBody" }, [
          h("div", { key: "n", className: "dtc-memberName" }, [
            h("span", { key: "t" }, member.name || member.id),
            member.phase ? h("span", { key: "p", className: "dtc-phase phase-" + member.phase }, phaseLabel(member.phase)) : null
          ]),
          h("div", { key: "c", className: "dtc-memberActivity" + (busy ? " is-busy" : "") }, line)
        ]),
        h("span", { key: "d", className: "dtc-dot " + memberDot(member) })
      ]);
    }

    function TaskChild(props) {
      var task = props.task;
      var state = taskState(task);
      var detail = props.expanded
        ? h("div", { key: "detail", className: "dtc-taskDetail" }, [
          task.description || "",
          (task.blockedBy && task.blockedBy.length) ? h("div", { key: "d", className: "dtc-taskRow" }, "依赖：" + task.blockedBy.join(" · ")) : null,
          (task.writeScopes && task.writeScopes.length) ? h("div", { key: "w", className: "dtc-taskRow" }, "写入范围：" + task.writeScopes.join(" · ")) : null
        ])
        : null;
      return h("div", {
        className: "dtc-task",
        role: "button",
        tabIndex: 0,
        title: task.ownerId ? "查看负责人对话" : "展开任务详情",
        onClick: function () { if (task.ownerId && props.onOpenOwner) props.onOpenOwner(); else props.onToggle(); }
      }, [
        h("div", { key: "m", className: "dtc-taskMain" }, [
          h("span", { key: "d", className: "dtc-dot " + state.dot }),
          h("span", { key: "i", className: "dtc-id" }, task.id),
          h("span", { key: "s", className: "dtc-taskSubject" }, task.subject || "(无标题)")
        ]),
        h("div", { key: "side", className: "dtc-taskSide" }, [
          task.ownerName
            ? h("span", { key: "o", className: "dtc-ownerPill", title: "负责人：" + task.ownerName }, [
              h("span", { key: "a", className: "dtc-avatarMini", style: avatarStyle(task.ownerName) }, initials(task.ownerName)),
              h("span", { key: "n" }, task.ownerName)
            ])
            : h("span", { key: "o", className: "dtc-ownerPill unowned" }, "未分配"),
          h("span", { key: "b", className: "dtc-chip " + state.cls }, state.badge),
          h("button", {
            key: "x",
            type: "button",
            className: "dtc-detailBtn" + (props.expanded ? " open" : ""),
            onClick: function (event) { event.stopPropagation(); props.onToggle(); }
          }, "▾")
        ]),
        detail
      ]);
    }

    function RequestCard(props) {
      var request = props.request;
      var done = request.tasks.filter(function (task) { return task.status === "completed"; }).length;
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
      return h("section", { className: "dtc-req" + (props.open ? " is-open" : "") }, [
        h("button", { key: "h", type: "button", className: "dtc-reqHead", onClick: props.onToggle }, [
          h("div", { key: "top", className: "dtc-reqTop" }, [
            h("span", { key: "i", className: "dtc-reqIndex" }, request.turn > 0 ? "第 " + request.turn + " 轮派发" : "未归类"),
            h("span", { key: "c", className: "dtc-chevron" }, "⌄")
          ]),
          h("div", { key: "t", className: "dtc-reqTitle" }, request.title),
          h("div", { key: "m", className: "dtc-reqMeta" }, [
            h("span", { key: "a", className: "dtc-avatars" }, displayMembers.slice(0, 4).map(function (member) {
              return h("span", { key: member.id, className: "dtc-avatarMini", style: avatarStyle(member.name), title: member.name }, initials(member.name));
            })),
            h("span", { key: "n" }, displayMembers.length + " 智能体"),
            h("span", { key: "k" }, request.tasks.length + " 任务"),
            request.activeTaskCount > 0 ? h("span", { key: "l", className: "dtc-chip ok" }, request.activeTaskCount + " 进行中") : null
          ]),
          request.tasks.length > 0 ? h("div", { key: "bar", className: "dtc-reqBar" }, h("div", { key: "f", className: "dtc-reqBarFill", style: { width: progress + "%" } })) : null
        ]),
        props.open ? h("div", { key: "children", className: "dtc-children" }, [
          request.tasks.map(function (task) {
            return h(TaskChild, {
              key: "t-" + task.id,
              task: task,
              expanded: props.expandedTask === task.id,
              onToggle: function () { props.onToggleTask(task.id); },
              onOpenOwner: function () { if (task.ownerId) props.onSelect(task.ownerId); }
            });
          })
        ]) : null
      ]);
    }

    function StepList(props) {
      var all = props.steps || [];
      var thinks = all.filter(function (step) { return step.kind === "reasoning"; });
      var steps = all.filter(function (step) { return step.kind !== "reasoning"; });
      if (steps.length === 0 && thinks.length === 0) return null;
      var totalMs = 0;
      steps.forEach(function (step) {
        if (step.time && step.resultTime) totalMs += Math.max(0, step.resultTime - step.time);
      });
      var totalText = totalMs > 0 ? (totalMs < 1000 ? totalMs + "ms" : (totalMs / 1000).toFixed(1) + "s") : "";
      return h("div", { className: "dtc-steps" }, [
        h("div", { key: "h", className: "dtc-stepsHead" }, props.standalone ? "他的执行过程" : "执行", " · " + steps.length + " 步" + (totalText ? " · 共 " + totalText : "")),
        steps.length > 0 ? h("ol", { key: "l", className: "dtc-stepList" }, steps.map(function (step, index) {
          var done = step.ok !== undefined ? step.ok : (step.result != null ? !step.isError : null);
          var ok = done === null ? "" : done ? " ok" : " bad";
          var stateText = done === null ? "运行中" : done ? "完成" : "失败";
          var dur = duration(step);
          var described = describeStep(step);
          return h("li", { key: step.callId || String(index), className: "dtc-stepItem" + ok }, [
            h("span", { key: "n", className: "dtc-stepNo" }, String(index + 1)),
            h("div", { key: "b", className: "dtc-stepMain" }, [
              h("div", { key: "t", className: "dtc-stepTitle", title: described.full || described.title }, described.title),
              h("div", { key: "m", className: "dtc-stepMeta" }, [stateText, described.detail, dur].filter(Boolean).join(" · "))
            ]),
            h("details", { key: "d", className: "dtc-stepFold" }, [
              h("summary", { key: "s", className: "dtc-stepMore", title: "看参数与结果" }, "详情"),
              step.subSteps && step.subSteps.length > 0 ? h("div", { key: "sub", className: "dtc-subSteps" }, step.subSteps.map(function (sub, sIdx) {
                var subDesc = describeStep(sub);
                return h("div", { key: String(sIdx), className: "dtc-subStep" + (sub.isError ? " bad" : "") }, [
                  h("span", { key: "st" }, sub.isError ? "✕" : "•"),
                  h("span", { key: "tx" }, subDesc.title)
                ]);
              })) : null,
              h("pre", { key: "p", className: "dtc-pre" }, [step.args || "", step.result != null ? "\n\n— 结果 —\n" + step.result : ""].join(""))
            ])
          ]);
        })) : null,
        thinks.length > 0 ? h("details", { key: "think", className: "dtc-thinkFold" }, [
          h("summary", { key: "s" }, "查看 " + thinks.length + " 段思考"),
          thinks.map(function (think, index) {
            return h("div", { key: index, className: "dtc-thinkText" }, think.text || "");
          })
        ]) : null
      ]);
    }

    function MissionCard(props) {
      var member = props.member;
      var [showPrompt, setShowPrompt] = useState(false);
      if (!member || !member.assignment) return null;
      var assign = member.assignment;
      var desc = assign.description || member.description || "";
      var prompt = assign.prompt || "";
      if (!desc && !prompt) return null;
      return h("div", { className: "dtc-missionCard" }, [
        h("div", { key: "h", className: "dtc-missionHead" }, [
          h("span", { key: "i", className: "dtc-missionIcon" }, "🎯"),
          h("span", { key: "t", className: "dtc-missionTitle" }, "任务目标: " + desc),
          prompt ? h("button", {
            key: "btn",
            type: "button",
            className: "dtc-missionToggle",
            onClick: function () { setShowPrompt(!showPrompt); }
          }, showPrompt ? "收起 Prompt ↑" : "查看 Prompt ▾") : null
        ]),
        showPrompt && prompt ? h("pre", { key: "p", className: "dtc-missionPrompt" }, prompt) : null
      ]);
    }

    function ChatBlock(props) {
      var block = props.block;
      if (block.type === "team") return h("div", { className: "dtc-event" }, block.item.text);
      if (block.type !== "user" && block.type !== "assistant") return null;
      var isMine = block.type === "user";
      var roleName = block.roleName || "成员";
      var time = clock(block.item.time);
      return h("div", { className: "dtc-talk " + (isMine ? "out" : "in") + " dtc-feedMsg" }, [
        h("span", {
          key: "a",
          className: "dtc-talkAvatar",
          style: isMine ? { background: "linear-gradient(135deg,#4f46e5,#7c3aed)" } : avatarStyle(roleName)
        }, isMine ? "我" : initials(roleName)),
        h("div", { key: "b", className: "dtc-talkBody" }, [
          h("div", { key: "l", className: "dtc-talkLabel" }, [
            h("b", { key: "n" }, isMine ? (block.isLead ? "用户" : "我") : roleName),
            isMine && !block.isLead ? h("span", { key: "tag", className: "dtc-roleTag" }, "任务书") : null,
            !isMine && block.isFinal ? h("span", { key: "tag2", className: "dtc-roleTag reply" }, "回复") : null,
            h("span", { key: "t" }, time)
          ]),
          h("div", { key: "c", className: "dtc-bubble " + (isMine ? "out" : "in") + " dtc-md" }, renderBubbleText(block.item.text)),
          block.steps && block.steps.length > 0 ? h(StepList, { key: "s", steps: block.steps }) : null
        ])
      ]);
    }

    function CockpitView(props) {
      var team = props.team;
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

      return h("div", { className: "dtc-cockpit" }, [
        h("div", { key: "hero", className: "dtc-cockpitHero" }, [
          h("div", { key: "badges", className: "dtc-cockpitBadgeRow" }, [
            h("span", { key: "tag", className: "dtc-cockpitTag" }, "◈ DSH Agent Teams 协作指挥中心"),
            h("span", { key: "st", className: "dtc-cockpitStateTag" }, [
              h("span", { key: "dot", className: "dtc-pulse" }),
              "智能体协同监控中"
            ])
          ]),
          h("div", { key: "title", className: "dtc-cockpitTitle" }, team.title || "Agent Teams 协作空间"),
          h("div", { key: "meta", className: "dtc-cockpitMeta" }, [
            h("span", { key: "cwd" }, "📂 工作目录: " + (team.cwd || "本地")),
            h("span", { key: "model" }, "🧠 调度模型: " + (team.model || "默认")),
            h("span", { key: "time" }, "⏱ 启动: " + ago(team.createdAt)),
            team.agentPreset ? h("span", { key: "preset" }, "🏷 预设模式: " + team.agentPreset) : null
          ])
        ]),

        h("div", { key: "metrics", className: "dtc-metricsGrid" }, [
          h("div", { key: "m1", className: "dtc-metricCard" }, [
            h("div", { key: "h", className: "dtc-metricHead" }, [
              h("span", { key: "l", className: "dtc-metricLabel" }, "智能体集群"),
              h("span", { key: "i", className: "dtc-metricIcon" }, "◈")
            ]),
            h("div", { key: "v", className: "dtc-metricVal" }, String(members.length + 1)),
            h("div", { key: "s", className: "dtc-metricSub" }, "1 主控 + " + members.length + " 协同成员")
          ]),
          h("div", { key: "m2", className: "dtc-metricCard" }, [
            h("div", { key: "h", className: "dtc-metricHead" }, [
              h("span", { key: "l", className: "dtc-metricLabel" }, "工具调度总数"),
              h("span", { key: "i", className: "dtc-metricIcon" }, "⚡")
            ]),
            h("div", { key: "v", className: "dtc-metricVal" }, String(totalToolCalls)),
            h("div", { key: "s", className: "dtc-metricSub" }, totalSteps + " 步骤 · " + successRate + "% 成功率")
          ]),
          h("div", { key: "m3", className: "dtc-metricCard" }, [
            h("div", { key: "h", className: "dtc-metricHead" }, [
              h("span", { key: "l", className: "dtc-metricLabel" }, "协同任务看板"),
              h("span", { key: "i", className: "dtc-metricIcon" }, "≡")
            ]),
            h("div", { key: "v", className: "dtc-metricVal" }, String(tasks.length)),
            h("div", { key: "s", className: "dtc-metricSub" }, completedTasks + " 已完成 · " + activeTasks + " 进行中")
          ]),
          h("div", { key: "m4", className: "dtc-metricCard" }, [
            h("div", { key: "h", className: "dtc-metricHead" }, [
              h("span", { key: "l", className: "dtc-metricLabel" }, "交互与请求"),
              h("span", { key: "i", className: "dtc-metricIcon" }, "💬")
            ]),
            h("div", { key: "v", className: "dtc-metricVal" }, String(totalMessages)),
            h("div", { key: "s", className: "dtc-metricSub" }, requests.length + " 轮次请求派发")
          ])
        ]),

        h("div", { key: "fleetSection", className: "dtc-sectionHead" }, [
          h("div", { key: "t", className: "dtc-sectionTitle" }, "智能体集群全貌 (Agent Fleet)"),
          h("div", { key: "s", className: "dtc-sectionSub" }, "点击进入独立执行流与工具链追踪")
        ]),

        h("div", { key: "fleetGrid", className: "dtc-fleetGrid" }, [
          h("div", { key: "leadCard", className: "dtc-fleetCard" }, [
            h("div", { key: "h", className: "dtc-fleetCardHead" }, [
              h("span", { key: "a", className: "dtc-avatar", style: { background: "linear-gradient(135deg,#4f46e5,#7c3aed)" } }, "主"),
              h("div", { key: "r", className: "dtc-fleetNameRow" }, [
                h("div", { key: "n", className: "dtc-fleetName" }, team.title || "Lead 主控调度"),
                h("span", { key: "tag", className: "dtc-fleetRoleTag lead" }, "Orchestrator 主控调度")
              ])
            ]),
            h("div", {
              key: "act",
              className: "dtc-fleetActivity" + ((lead.activity && (lead.activity.kind === "tool" || lead.activity.kind === "thinking")) ? " busy" : "")
            }, (lead.activity && lead.activity.label) ? ("● " + lead.activity.label) : "● 空闲待命"),
            lead.activity && lead.activity.lastPreview ? h("div", { key: "prev", className: "dtc-fleetMission" }, lead.activity.lastPreview) : null,
            h("button", {
              key: "btn",
              type: "button",
              className: "dtc-fleetBtn",
              onClick: function () { props.onSelect(team.leadId); }
            }, "查看主控指令流 →")
          ]),

          members.map(function (member) {
            var act = member.activity || {};
            var busy = act.kind === "tool" || act.kind === "thinking";
            var mission = (member.assignment && member.assignment.description) || member.description || "";
            return h("div", { key: member.id, className: "dtc-fleetCard" }, [
              h("div", { key: "h", className: "dtc-fleetCardHead" }, [
                h("span", { key: "a", className: "dtc-avatar", style: avatarStyle(member.name) }, initials(member.name)),
                h("div", { key: "r", className: "dtc-fleetNameRow" }, [
                  h("div", { key: "n", className: "dtc-fleetName" }, member.name || member.id),
                  h("span", { key: "tag", className: "dtc-fleetRoleTag" }, phaseLabel(member.phase) || "协同智能体")
                ])
              ]),
              h("div", { key: "act", className: "dtc-fleetActivity" + (busy ? " busy" : "") }, [
                h("span", { key: "dot", className: "dtc-dot " + memberDot(member) }),
                (act.label || "空闲") + (act.lastTime ? " · " + ago(act.lastTime) : "")
              ]),
              h("div", { key: "stats", className: "dtc-fleetStats" }, [
                h("span", { key: "tc" }, [h("b", { key: "b" }, String(member.toolCalls || 0)), " 次工具"]),
                h("span", { key: "ms" }, [h("b", { key: "b" }, String(member.messages || 0)), " 条消息"]),
                h("span", { key: "st" }, [h("b", { key: "b" }, String(member.stepCount || 0)), " 步骤"])
              ]),
              mission ? h("div", { key: "m", className: "dtc-fleetMission" }, "🎯 " + mission) : null,
              h("button", {
                key: "btn",
                type: "button",
                className: "dtc-fleetBtn",
                onClick: function () { props.onSelect(member.id); }
              }, "进入独立会话流 (View Stream) →")
            ]);
          })
        ]),

        h("div", { key: "taskSection", className: "dtc-sectionHead" }, [
          h("div", { key: "t", className: "dtc-sectionTitle" }, "协同工作流与任务派发 (Tasks & Workflow)")
        ]),

        tasks.length > 0
          ? h("div", { key: "tasksMatrix", className: "dtc-cockpitTasks" }, [
            h("div", { key: "grid", className: "dtc-tasksGrid" }, tasks.map(function (task) {
              var st = taskState(task);
              var hasOwner = Boolean(task.ownerId);
              return h("div", {
                key: task.id,
                className: "dtc-taskCardItem" + (hasOwner ? "" : " is-unassigned"),
                onClick: function () { if (task.ownerId) props.onSelect(task.ownerId); }
              }, [
                h("div", { key: "h", className: "dtc-taskCardHead" }, [
                  h("span", { key: "id", className: "dtc-id" }, task.id),
                  h("span", { key: "title", className: "dtc-taskCardTitle" }, task.subject || "(无标题)"),
                  h("span", { key: "chip", className: "dtc-chip " + st.cls }, st.badge)
                ]),
                task.description ? h("div", { key: "d", className: "dtc-taskCardDesc" }, task.description) : null,
                h("div", { key: "foot", className: "dtc-taskCardFoot" }, [
                  task.ownerName
                    ? h("span", { key: "o", className: "dtc-ownerPill" }, [
                      h("span", { key: "a", className: "dtc-avatarMini", style: avatarStyle(task.ownerName) }, initials(task.ownerName)),
                      h("span", { key: "n" }, task.ownerName)
                    ])
                    : h("span", { key: "o", className: "dtc-ownerPill unowned" }, "未指派"),
                  hasOwner
                    ? h("span", { key: "hint", style: { fontSize: "10.5px", color: "var(--dtc-brand)" } }, "查看对话 →")
                    : h("span", { key: "hint", style: { fontSize: "10.5px", color: "var(--dtc-dim2)" } }, "待认领")
                ])
              ]);
            }))
          ])
          : h("div", { key: "autoFlow", className: "dtc-autoFlow" }, [
            h("div", { key: "f1", className: "dtc-flowStep" }, [
              h("span", { key: "a", className: "dtc-avatarMini", style: { background: "#4f46e5" } }, "主"),
              "Lead 任务指派"
            ]),
            h("span", { key: "arr1", className: "dtc-flowArrow" }, "→"),
            members.length > 0 ? h("div", { key: "f2", className: "dtc-flowStep" }, [
              h("span", { key: "a", className: "dtc-avatarMini", style: avatarStyle(members[0].name) }, initials(members[0].name)),
              members[0].name
            ]) : null,
            members.length > 1 ? h("span", { key: "arr2", className: "dtc-flowArrow" }, "→") : null,
            members.length > 1 ? h("div", { key: "f3", className: "dtc-flowStep" }, [
              h("span", { key: "a", className: "dtc-avatarMini", style: avatarStyle(members[1].name) }, initials(members[1].name)),
              members[1].name
            ]) : null,
            h("span", { key: "arr3", className: "dtc-flowArrow" }, "→"),
            h("div", { key: "f4", className: "dtc-flowStep" }, "成果交付与归档")
          ])
      ]);
    }

    function Empty(props) {
      return h("div", { className: "dtc-empty" }, [
        h("div", { key: "i", className: "dtc-emptyIcon" }, props.icon || "◈"),
        h("h4", { key: "h" }, props.title || ""),
        props.hint ? h("p", { key: "p" }, props.hint) : null
      ]);
    }

    function TeamConsolePage() {
      var [snap, setSnap] = useState({ ready: false, error: null, api: null, teams: [], leadId: null, team: null, selected: null, transcript: null, updatedAt: 0 });
      var [openTurns, setOpenTurns] = useState({});
      var [expandedTask, setExpandedTask] = useState(null);
      var [showJump, setShowJump] = useState(false);
      var stateRef = useRef({ api: null, teams: [], leadId: null, team: null, selected: null });
      var reqSeqRef = useRef(0);
      var aliveRef = useRef(true);
      var feedRef = useRef(null);
      var stickRef = useRef(true);

      var publish = function (patch) {
        if (!aliveRef.current) return;
        setSnap(function (previous) { return Object.assign({}, previous, patch, { ready: true }); });
      };

      var tick = async function () {
        var seq = (reqSeqRef.current += 1);
        try {
          var current = stateRef.current;
          if (!current.api) {
            var found = await findApi();
            if (seq !== reqSeqRef.current || !aliveRef.current) return;
            if (!found) {
              publish({ error: "没有找到本地数据服务（127.0.0.1:4318..4337）。重启 DSH 让插件启动服务。", api: null });
              return;
            }
            current.api = found;
          }
          var teamsResponse = await getJson(current.api + "/api/teams");
          if (seq !== reqSeqRef.current || !aliveRef.current) return;
          var teams = teamsResponse.teams || [];
          current.teams = teams;
          if (teams.length === 0) {
            publish({ api: current.api, teams: [], team: null, leadId: null, selected: null, transcript: null, error: null, updatedAt: Date.now() });
            return;
          }
          var keep = current.leadId && teams.some(function (team) { return team.leadId === current.leadId; });
          var leadId = keep ? current.leadId : teams[0].leadId;
          current.leadId = leadId;
          var teamResponse = await getJson(current.api + "/api/team?lead=" + encodeURIComponent(leadId));
          if (seq !== reqSeqRef.current || !aliveRef.current) return;
          var team = teamResponse.team;
          current.team = team;
          var selected = current.selected;
          var exists = selected && (selected === leadId || selected === "__overview__" || team.members.some(function (member) { return member.id === selected; }));
          if (!exists) selected = team.members.length > 0 ? team.members[0].id : leadId;
          current.selected = selected;

          var transcript = null;
          if (selected !== "__overview__") {
            try {
              var transcriptResponse = await getJson(current.api + "/api/session/" + encodeURIComponent(selected) + "?limit=200");
              if (seq !== reqSeqRef.current || !aliveRef.current) return;
              transcript = transcriptResponse.transcript;
            } catch (sessionError) {
              if (seq !== reqSeqRef.current || !aliveRef.current) return;
              transcript = null;
            }
          }
          publish({
            api: current.api,
            teams: teams,
            leadId: leadId,
            team: team,
            selected: selected,
            transcript: transcript,
            error: null,
            updatedAt: Date.now()
          });
        } catch (error) {
          if (seq !== reqSeqRef.current || !aliveRef.current) return;
          if (error && !error.status) stateRef.current.api = null;
          publish({ error: "读取失败：" + (error && error.message ? error.message : String(error)) });
        }
      };

      useEffect(function () {
        aliveRef.current = true;
        tick();
        var timer = setInterval(tick, POLL_MS);
        return function () {
          aliveRef.current = false;
          clearInterval(timer);
        };
      }, []);

      useEffect(function () {
        if (snap.selected === "__overview__") return;
        if (stickRef.current && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
      }, [snap.transcript]);

      useEffect(function () {
        if (snap.selected !== "__overview__") return;
        if (feedRef.current) feedRef.current.scrollTop = 0;
      }, [snap.selected]);

      var onSelect = function (id) {
        var changed = stateRef.current.selected !== id;
        stateRef.current.selected = id;
        stickRef.current = true;
        setShowJump(false);
        setExpandedTask(null);
        if (changed) {
          publish({ selected: id, transcript: id === "__overview__" ? null : snap.transcript });
        }
        tick();
      };
      var onTeamChange = function (event) {
        var nextLead = event.target.value;
        stateRef.current.leadId = nextLead;
        stateRef.current.selected = null;
        stickRef.current = true;
        setShowJump(false);
        setExpandedTask(null);
        setOpenTurns({});
        publish({ leadId: nextLead, selected: null, transcript: null });
        tick();
      };
      var onScroll = function () {
        var el = feedRef.current;
        if (!el) return;
        var nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        stickRef.current = nearBottom;
        setShowJump(!nearBottom);
      };
      var jumpToLatest = function () {
        stickRef.current = true;
        setShowJump(false);
        var el = feedRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      };
      var toggleTurn = function (turn, open) {
        setOpenTurns(function (previous) {
          var next = Object.assign({}, previous);
          next[turn] = open;
          return next;
        });
      };
      var toggleTask = function (id) {
        setExpandedTask(function (prev) { return prev === id ? null : id; });
      };

      var team = snap.team;
      var leadId = snap.leadId;
      var selected = snap.selected;
      var transcript = snap.transcript;

      if (!snap.ready) {
        var skeletonRows = [0, 1, 2].map(function (index) {
          return h("div", { key: "r" + index, className: "dtc-skelRow" }, [
            h("span", { key: "d", className: "dtc-skelDot" }),
            h("div", { key: "c", className: "dtc-skelCol" }, [
              h("div", { key: "l1", className: "dtc-skelLine", style: { width: "58%" } }),
              h("div", { key: "l2", className: "dtc-skelLine short" })
            ])
          ]);
        });
        var skeletonFeed = [0, 1, 2].map(function (index) {
          return h("div", { key: "s" + index, className: "dtc-skelBlock" });
        });
        return h("div", { className: "dtc-root" }, [
          h("header", { key: "t", className: "dtc-top" }, [
            h("div", { key: "b", className: "dtc-brand" }, [
              h("span", { key: "m", className: "dtc-mark" }, "◈"),
              h("span", { key: "t", className: "dtc-brandTitle" }, "Agent Teams"),
              h("span", { key: "bg", className: "dtc-brandBadge" }, "协同控制台")
            ]),
            h("div", { key: "l", className: "dtc-live" }, [h("span", { key: "p", className: "dtc-pulse" }), h("span", null, "连接中")])
          ]),
          h("main", { key: "m", className: "dtc-main" }, [
            h("aside", { key: "rail", className: "dtc-rail" }, [
              h("div", { key: "h", className: "dtc-railHead" }, [h("span", null, "协同智能体与请求")]),
              skeletonRows
            ]),
            h("section", { key: "stream", className: "dtc-stream" }, [
              h("div", { key: "f", className: "dtc-feed" }, skeletonFeed)
            ])
          ])
        ]);
      }
      if (snap.error && !team) {
        return h("div", { className: "dtc-root" }, [
          h("header", { key: "t", className: "dtc-top" }, [
            h("div", { key: "b", className: "dtc-brand" }, [
              h("span", { key: "m", className: "dtc-mark" }, "◈"),
              h("span", { key: "t", className: "dtc-brandTitle" }, "Agent Teams"),
              h("span", { key: "bg", className: "dtc-brandBadge" }, "协同控制台")
            ]),
            h("div", { key: "l", className: "dtc-live" }, [h("span", { key: "p", className: "dtc-pulse", style: { background: "var(--dtc-bad)" } }), h("span", null, "未连接")])
          ]),
          h(Empty, { key: "e", icon: "⚠", title: "读不到团队数据", hint: snap.error })
        ]);
      }
      if (!team) {
        return h("div", { className: "dtc-root" }, [
          h("header", { key: "t", className: "dtc-top" }, [
            h("div", { key: "b", className: "dtc-brand" }, [
              h("span", { key: "m", className: "dtc-mark" }, "◈"),
              h("span", { key: "t", className: "dtc-brandTitle" }, "Agent Teams"),
              h("span", { key: "bg", className: "dtc-brandBadge" }, "协同控制台")
            ]),
            h("div", { key: "l", className: "dtc-live" }, [h("span", { key: "p", className: "dtc-pulse" }), h("span", null, "实时")])
          ]),
          h(Empty, { key: "e", icon: "◈", title: "还没有协同团队", hint: "在任意会话里用自然语言让我组建团队，例如「组个团队做这件事」。成员、任务看板、会话流将自动汇聚在此。" })
        ]);
      }

      var isOverview = selected === "__overview__";
      var isLead = selected === leadId;
      var selectedMember = null;
      for (var mi = 0; mi < team.members.length; mi += 1) {
        if (team.members[mi].id === selected) { selectedMember = team.members[mi]; break; }
      }
      var memberById = {};
      team.members.forEach(function (member) { memberById[member.id] = member; });
      var requests = (team.requests || []).map(function (request) {
        return {
          turn: request.turn,
          title: request.title,
          activeTaskCount: request.activeTaskCount || 0,
          members: request.memberIds.map(function (id) { return memberById[id]; }).filter(Boolean),
          tasks: team.tasks.filter(function (task) { return request.taskIds.indexOf(task.id) !== -1; })
        };
      });
      if (requests.length === 0) {
        requests = [{ turn: 0, title: "全部成员与任务", activeTaskCount: 0, members: team.members, tasks: team.tasks }];
      }

      var activity = transcript && transcript.activity ? transcript.activity : {};
      var streamTitle = isOverview
        ? "团队指挥中枢 · 全局监控"
        : (isLead ? (team.title || leadId) : ((transcript && (transcript.label || transcript.title)) || selected));
      var meta = [];
      if (isOverview) {
        meta.push(team.members.length + " 协同智能体");
        meta.push(team.tasks.length + " 项任务");
      } else {
        if (transcript && transcript.model) meta.push(transcript.model);
        if (activity.label) meta.push(activity.label);
        if (transcript) meta.push(transcript.total + " 条记录");
      }

      var roleName = isLead ? "Lead" : ((selectedMember && (selectedMember.name || selectedMember.id)) || "成员");
      var visibleItems = transcript ? transcript.items.filter(function (item) { return item.kind !== "context"; }) : [];
      var blocks = [];
      visibleItems.forEach(function (item) {
        var isStep = item.kind === "tool" || item.kind === "tool_result" || item.kind === "reasoning";
        if (isStep) {
          var last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
          if (last && last.type === "assistant") {
            last.steps.push(item);
          } else if (last && last.type === "steps") {
            last.steps.push(item);
          } else {
            blocks.push({ type: "steps", steps: [item], key: "steps-" + item.id });
          }
          return;
        }
        if (item.kind === "user") blocks.push({ type: "user", item: item, steps: [], isLead: isLead });
        else if (item.kind === "assistant") blocks.push({ type: "assistant", item: item, steps: [], roleName: roleName });
        else blocks.push({ type: item.kind, item: item, steps: [] });
      });
      for (var bi = blocks.length - 1; bi >= 0; bi -= 1) {
        if (blocks[bi].type === "assistant") { blocks[bi].isFinal = true; break; }
      }

      var feedContent = isOverview
        ? h(CockpitView, {
          team: team,
          onSelect: onSelect
        })
        : (!transcript
          ? h(Empty, { key: "empty", icon: "◈", title: "选择左侧智能体", hint: "点击智能体名册或任务负责人，查看完整交互流与工具链追踪。" })
          : (visibleItems.length === 0
            ? h(Empty, { key: "empty", icon: "◈", title: "没有可显示的记录" })
            : [
              transcript.truncated ? h("div", { key: "trunc", className: "dtc-truncHint" }, "仅显示最近 " + transcript.items.length + " 条记录（共 " + transcript.total + " 条）") : null
            ].concat(blocks.map(function (block, index) {
              if (block.type === "steps") {
                return h(StepList, { key: block.key, steps: block.steps, standalone: true });
              }
              return h(ChatBlock, { key: block.item.id || String(index), block: block });
            }))));

      return h("div", { className: "dtc-root" }, [
        h("header", { key: "top", className: "dtc-top" }, [
          h("div", { key: "b", className: "dtc-brand" }, [
            h("span", { key: "m", className: "dtc-mark" }, "◈"),
            h("span", { key: "t", className: "dtc-brandTitle" }, "Agent Teams"),
            h("span", { key: "bg", className: "dtc-brandBadge" }, "协同控制台")
          ]),
          h("span", { key: "sw", className: "dtc-selectWrap" }, h("select", {
            className: "dtc-team",
            value: leadId || "",
            onChange: onTeamChange,
            title: "切换协同团队"
          }, snap.teams.map(function (item) {
            return h("option", { key: item.leadId, value: item.leadId }, (item.title || item.leadId) + " · " + item.memberCount + " 人 · " + item.openTaskCount + " 任务");
          }))),
          h("div", { key: "l", className: "dtc-live" }, [
            h("span", { key: "p", className: "dtc-pulse" }),
            h("span", { key: "x" }, "实时连接"),
            h("span", { key: "c", className: "dtc-clock" }, clock(snap.updatedAt))
          ])
        ]),
        h("main", { key: "main", className: "dtc-main" }, [
          h("aside", { key: "rail", className: "dtc-rail" }, [
            h("button", {
              key: "overviewNav",
              type: "button",
              className: "dtc-overviewBtn" + (isOverview ? " is-on" : ""),
              onClick: function () { onSelect("__overview__"); }
            }, [
              h("span", { key: "icon", className: "dtc-overviewIcon" }, "◈"),
              h("span", { key: "text", className: "dtc-overviewText" }, [
                h("b", { key: "title" }, "团队指挥中枢"),
                h("small", { key: "sub" }, (team.members.length + 1) + " 智能体 · " + team.tasks.length + " 任务")
              ]),
              h("span", { key: "badge", className: "dtc-overviewBadge" }, "总览")
            ]),

            // Agents Section
            h("div", { key: "agentsSec", className: "dtc-railSection" }, [
              h("div", { key: "h", className: "dtc-railHead" }, [
                h("span", null, "协同智能体"),
                h("b", null, String(team.members.length + 1))
              ]),
              (function () {
                var leadAct = (team.lead && team.lead.activity) || {};
                var leadBusy = leadAct.kind === "tool" || leadAct.kind === "thinking";
                var leadLine = leadAct.label || "空闲";
                if (leadAct.lastTime) leadLine += " · " + ago(leadAct.lastTime);
                return h("button", {
                  key: "agent-lead",
                  type: "button",
                  className: "dtc-member" + (selected === leadId ? " is-on" : ""),
                  title: team.title || leadId,
                  onClick: function () { onSelect(leadId); }
                }, [
                  h("span", { key: "a", className: "dtc-avatar", style: { background: "linear-gradient(135deg,#4f46e5,#7c3aed)" } }, "主"),
                  h("span", { key: "b", className: "dtc-memberBody" }, [
                    h("div", { key: "n", className: "dtc-memberName" }, [
                      h("span", { key: "t" }, "Lead 主控"),
                      h("span", { key: "p", className: "dtc-memberRoleTag" }, "主控")
                    ]),
                    h("div", { key: "c", className: "dtc-memberActivity" + (leadBusy ? " is-busy" : "") }, leadLine)
                  ]),
                  h("span", { key: "d", className: "dtc-dot " + (leadBusy ? "ok busy" : "") })
                ]);
              })(),
              team.members.map(function (member) {
                return h(MemberChild, {
                  key: "agent-" + member.id,
                  member: member,
                  active: selected === member.id,
                  onSelect: function () { onSelect(member.id); }
                });
              })
            ]),

            // Requests Section
            h("div", { key: "reqsSec", className: "dtc-railSection" }, [
              h("div", { key: "h", className: "dtc-railHead" }, [
                h("span", null, "请求与任务"),
                h("b", null, String(requests.length))
              ]),
              requests.map(function (request, index) {
                var open = openTurns[request.turn] !== undefined ? openTurns[request.turn] : index === requests.length - 1;
                return h(RequestCard, {
                  key: "req-" + request.turn,
                  request: request,
                  open: open,
                  selected: selected,
                  expandedTask: expandedTask,
                  onToggle: function () { toggleTurn(request.turn, !open); },
                  onToggleTask: toggleTask,
                  onSelect: onSelect
                });
              })
            ])
          ]),
          h("section", { key: "stream", className: "dtc-stream" }, [
            h("header", { key: "h", className: "dtc-streamHead" }, [
              !isOverview ? h("button", {
                key: "back",
                type: "button",
                className: "dtc-backOverviewBtn",
                onClick: function () { onSelect("__overview__"); }
              }, "← 中枢总览") : null,
              h("span", { key: "k", className: "dtc-kind" }, isOverview ? "总览" : (isLead ? "Lead" : "成员")),
              h("span", { key: "t", className: "dtc-stitle" }, streamTitle),
              h("span", { key: "m", className: "dtc-smeta" }, meta.join("  ·  "))
            ]),

            !isOverview && selectedMember ? h(MissionCard, { key: "mission", member: selectedMember }) : null,

            h("div", { key: "bar", className: "dtc-sectBar dtc-guide" }, [
              h("b", { key: "t" }, isOverview ? "协同链路与实时动态" : "完整聊天记录"),
              visibleItems.length > 0 ? h("span", { key: "n", className: "dtc-sectNum" }, String(visibleItems.length)) : null,
              h("span", { key: "g", className: "dtc-guideText" }, [
                h("span", { key: "a", className: "dtc-guideItem" }, [
                  h("span", { key: "x", className: "dtc-guideNo" }, "①"),
                  "我给他的任务（左）"
                ]),
                h("span", { key: "b", className: "dtc-guideItem" }, [
                  h("span", { key: "x", className: "dtc-guideNo" }, "②"),
                  "他的执行过程（中间）"
                ]),
                h("span", { key: "c", className: "dtc-guideItem" }, [
                  h("span", { key: "x", className: "dtc-guideNo" }, "③"),
                  "他的回复（右）"
                ])
              ])
            ]),

            h("div", { key: "f", className: "dtc-feed", ref: feedRef, onScroll: onScroll }, feedContent),
            showJump && !isOverview ? h("button", { key: "jump", type: "button", className: "dtc-jump", onClick: jumpToLatest }, "回到最新 ↓") : null
          ])
        ])
      ]);
    }

    function TeamConsoleIcon(props) {
      var Icon = primitives && primitives.IconUserOutlineRegular;
      var size = (props && props.size) || 16;
      if (Icon) return h(Icon, { size: size });
      return h("span", { style: { fontSize: Math.max(12, size - 2) } }, "◈");
    }

    function apply(ctx) {
      var styleTag = ensureStyle();
      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function () {
          return function () {
            if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
          };
        }, "team-console: styles");
      }
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 30,
          label: "团队"
        }, TeamConsoleIcon);
      });
      ctx.slots.inject("main", function () {
        return ctx.slots.register({
          name: "main",
          key: PANEL_ID
        }, TeamConsolePage);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});