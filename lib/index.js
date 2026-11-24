/**
 * dsh-team-console — Cordis Host 插件入口。
 *
 * 在 Host 进程内启动只监听 127.0.0.1 的团队仪表盘。插件不做任何模型可见的注册：
 * 不注册工具、不注入提示词、不写会话事件，因此不影响模型请求与 KV cache。
 */
import { startTeamConsole } from "./server.js";

export const name = "team-console";
export const inject = [];

/**
 * 启动仪表盘。
 * @param ctx cordis 上下文
 * @param config 插件配置 {port, sessionsRoot, maxAgeDays}
 */
export function apply(ctx, config) {
  const options = Object.assign({}, config || {});
  if (ctx && ctx.logger) options.logger = ctx.logger;
  let handle;
  try {
    handle = startTeamConsole(options);
  } catch (error) {
    // 配置非法（如端口越界）只让仪表盘缺席，不能让 Host 插件整体加载失败。
    const message = error && error.message ? error.message : String(error);
    try {
      ctx?.logger?.warn?.("[team-console] 仪表盘未启动：" + message);
    } catch {
      /* ignore */
    }
    return () => {};
  }
  if (handle && handle.ready && typeof handle.ready.catch === "function") {
    handle.ready.catch((error) => {
      try {
        ctx?.logger?.warn?.("[team-console] " + (error && error.message ? error.message : error));
      } catch {
        /* ignore */
      }
    });
  }
  const dispose = () => handle.close();
  if (ctx && typeof ctx.effect === "function") {
    ctx.effect(() => dispose, "team-console: dashboard server");
  }
  return dispose;
}
