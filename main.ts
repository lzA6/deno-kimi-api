// main.ts — no-auth & vercel-friendly

import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// 读取 .env（在 Vercel 上没有也没关系）
await load({ export: true });

const settings = {
  APP_NAME: "kimi-ai-2api-deno",
  APP_VERSION: "1.0.0",
  DESCRIPTION: "Kimi 转 OpenAI 兼容 API（无鉴权·Vercel 适配）",
  PORT: parseInt(Deno.env.get("PORT") || "8088", 10),

  // Kimi 上游
  UPSTREAM_URL: "https://kimi-ai.chat/wp-admin/admin-ajax.php",
  CHAT_PAGE_URL: "https://kimi-ai.chat/chat/",

  KNOWN_MODELS: ["kimi-k2-instruct-0905", "kimi-k2-instruct"],
  DEFAULT_MODEL: "kimi-k2-instruct-0905",

  // 会话缓存（毫秒）
  SESSION_CACHE_TTL: parseInt(Deno.env.get("SESSION_CACHE_TTL") || "3600", 10) * 1000,
};

// ---------- 小工具 ----------
const encoder = new TextEncoder();
const DONE_CHUNK = encoder.encode("data: [DONE]\n\n");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function sseData(obj: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
}
function chunk(id: string, model: string, content: string, finish: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}

// ---------- Kimi Provider ----------
class KimiAIProvider {
  private sessionCache = new Map<string, any>();
  private nonce: string | null = null;
  private noncePromise: Promise<string> | null = null;

  private async fetchNonce(): Promise<string> {
    const res = await fetch(settings.CHAT_PAGE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`fetch chat page ${res.status}`);
    const html = await res.text();
    const m = html.match(/var kimi_ajax = ({.*?});/);
    if (!m?.[1]) throw new Error("no kimi_ajax nonce");
    const nonce = JSON.parse(m[1]).nonce;
    if (!nonce) throw new Error("nonce missing");
    console.log("nonce:", nonce);
    return nonce;
  }
  private getNonce(force = false) {
    if (!this.noncePromise || force) {
      this.noncePromise = this.fetchNonce()
        .then((n) => (this.nonce = n))
        .catch((e) => {
          this.noncePromise = null;
          throw e;
        });
    }
    return this.noncePromise;
  }

  private sess(userKey: string) {
    const hit = this.sessionCache.get(userKey);
    if (hit) return hit.data;
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const data = { kimi_session_id: id, messages: [] as Array<{ role: string; content: string }> };
    const tid = setTimeout(() => this.sessionCache.delete(userKey), settings.SESSION_CACHE_TTL);
    this.sessionCache.set(userKey, { data, tid });
    return data;
  }

  private promptFrom(history: { role: string; content: string }[], last: string) {
    const lines = history.map((m) => `${m.role === "user" ? "用户" : "模型"}: ${m.content}`);
    return [...lines, `用户: ${last}`].join("\n").trim();
  }
  private payload(prompt: string, model: string, sid: string, nonce: string) {
    const upstream =
      model === "kimi-k2-instruct-0905"
        ? "moonshotai/Kimi-K2-Instruct-0905"
        : model === "kimi-k2-instruct"
        ? "moonshotai/Kimi-K2-Instruct"
        : (() => {
            throw new Error(`unsupported model: ${model}`);
          })();
    return new URLSearchParams({
      action: "kimi_send_message",
      nonce,
      message: prompt,
      model: upstream,
      session_id: sid,
    });
  }

  async models() {
    const body = {
      object: "list",
      data: settings.KNOWN_MODELS.map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "lzA6",
      })),
    };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  async chat(req: Request) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const { messages, user, model = settings.DEFAULT_MODEL } = await req.json();
    if (!Array.isArray(messages) || !messages.length || messages.at(-1)?.role !== "user") {
      return new Response(JSON.stringify({ error: "messages 为空或最后一条不是 user" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    const last = messages.at(-1)!;
    let session = null as null | { kimi_session_id: string; messages: any[] };
    let prompt = last.content as string;
    let sid = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    if (user) {
      session = this.sess(user);
      prompt = this.promptFrom(session.messages, last.content);
      sid = session.kimi_session_id;
    }

    const reqId = `chatcmpl-${crypto.randomUUID()}`;
    const stream = new ReadableStream({
      start: async (ctl) => {
        const call = async (retry = false): Promise<string | null> => {
          try {
            const nonce = await this.getNonce(retry);
            const body = this.payload(prompt, model, sid, nonce);
            const r = await fetch(settings.UPSTREAM_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
              },
              body,
            });
            if (!r.ok) throw new Error(String(r.status));
            const j = await r.json();
            if (!j.success) throw new Error(String(j.data ?? "upstream error"));
            return j.data?.message ?? "";
          } catch (e) {
            if (!retry) return await call(true);
            return null;
          }
        };

        const text = await call();
        if (text == null) {
          ctl.enqueue(sseData(chunk(reqId, model, "上游失败", "stop")));
          ctl.enqueue(DONE_CHUNK);
          ctl.close();
          return;
        }

        if (session) {
          session.messages.push({ role: "user", content: last.content });
          session.messages.push({ role: "assistant", content: text });
        }

        for (const ch of text as string) {
          ctl.enqueue(sseData(chunk(reqId, model, ch)));
          await new Promise((r) => setTimeout(r, 12));
        }
        ctl.enqueue(sseData(chunk(reqId, model, "", "stop")));
        ctl.enqueue(DONE_CHUNK);
        ctl.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...CORS,
      },
    });
  }
}

const provider = new KimiAIProvider();

// 关键：导出给 Vercel 的 handler（Vercel 调这个，不要自己监听端口）
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  // 预检 CORS
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // 根页面：不需要任何认证
  if (p === "/" && req.method === "GET") {
    const html = `<!doctype html><meta charset="utf-8"><title>${settings.APP_NAME}</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:40px;max-width:760px;margin:auto}code{background:#f4f4f4;padding:.2em .4em;border-radius:6px}</style>
<h1>✅ ${settings.APP_NAME} v${settings.APP_VERSION}</h1>
<p>${settings.DESCRIPTION}</p>
<p>无需鉴权，直接调用：</p>
<pre><code>GET  /v1/models
POST /v1/chat/completions</code></pre>
<p>示例 cURL：</p>
<pre><code>curl -s https://YOUR-VERCEL-URL.vercel.app/v1/models</code></pre>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
  }

  if (p === "/v1/models" && req.method === "GET") return provider.models();
  if (p === "/v1/chat/completions" && req.method === "POST") return provider.chat(req);

  return new Response(JSON.stringify({ detail: "Not Found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// 仅“本地直接运行 main.ts”时才监听端口；Vercel 不会走这里
if (import.meta.main) {
  Deno.serve({ port: settings.PORT }, handle);
}
