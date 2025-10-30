#!/usr/bin/env deno run --allow-net --allow-env --allow-read
// 自适配入口：尝试复用 main.ts 的多种可能导出形态
const mod = await import("../main.ts");

function pickHandler(m: Record<string, unknown>): ((req: Request) => Promise<Response> | Response) | null {
  // 1) 显式导出的 handle(req)
  if (typeof m.handle === "function") return m.handle as any;

  // 2) Hono 等框架常见：export const app = new Hono(); -> app.fetch(req)
  if (m.app && typeof (m.app as any).fetch === "function") {
    return (req: Request) => (m.app as any).fetch(req);
  }

  // 3) 默认导出就是处理函数
  if (typeof m.default === "function") return m.default as any;

  // 4) 模块本身导出 fetch(req)
  if (typeof (m as any).fetch === "function") return (m as any).fetch as any;

  return null;
}

const handler = pickHandler(mod);

export default async function (req: Request): Promise<Response> {
  if (handler) return await handler(req);
  // 兜底错误：提示当前 main.ts 暴露了哪些键，方便你修改
  const keys = Object.keys(mod);
  const hint = `Vercel 入口没有找到可用的请求处理函数。
期待：export function handle(req), 或导出 app.fetch, 或默认导出函数。
当前 main.ts 导出键：${JSON.stringify(keys)}`
  return new Response(hint, { status: 500 });
}
