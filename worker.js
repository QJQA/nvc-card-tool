/**
 * 感受与需要翻牌桌 —— AI 分析代理（Cloudflare Worker · 多模型版）
 *
 * 支持的服务商（在 Worker 环境变量里用 PROVIDER 选择一家）：
 *
 *   PROVIDER 值      服务商            默认模型            密钥申请地址
 *   ────────────────────────────────────────────────────────────────────
 *   anthropic       Anthropic Claude  claude-sonnet-4-6   console.anthropic.com
 *   openai          OpenAI            gpt-4o-mini         platform.openai.com
 *   gemini          Google Gemini     gemini-2.5-flash    aistudio.google.com
 *   deepseek        深度求索 DeepSeek  deepseek-chat       platform.deepseek.com
 *   kimi            月之暗面 Kimi      moonshot-v1-8k      platform.moonshot.cn
 *   qwen            阿里通义千问       qwen-plus           bailian.console.aliyun.com
 *   zhipu           智谱 GLM          glm-4-flash         open.bigmodel.cn
 *
 * 需要配置的环境变量（Worker → Settings → Variables and Secrets）：
 *   PROVIDER   普通变量（Text），上表任一值。不填默认 anthropic
 *   API_KEY    Secret，对应服务商的密钥
 *   MODEL      普通变量（Text），可选。想换默认模型时填，如 deepseek-reasoner
 *
 * 换服务商 = 改 PROVIDER + 换 API_KEY，前端 index.html 不需要任何改动。
 */

// 允许调用本接口的网页来源。上线后建议改成你的域名，如 "https://nvc.example.com"
const ALLOWED_ORIGIN = "*";

// 输入上限，防止超长请求消耗额度
const MAX_PROMPT_CHARS = 4000;

// 服务商注册表。除 anthropic 外均为 OpenAI 兼容接口
const PROVIDERS = {
  anthropic: { style: "anthropic", url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-6" },
  openai:    { style: "openai", url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  gemini:    { style: "openai", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.5-flash" },
  deepseek:  { style: "openai", url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
  kimi:      { style: "openai", url: "https://api.moonshot.cn/v1/chat/completions", model: "moonshot-v1-8k" },
  qwen:      { style: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus" },
  zhipu:     { style: "openai", url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" },
};

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: { message: "只接受 POST 请求" } }, 405);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: { message: "请求体不是有效 JSON" } }, 400); }

    // 只放行本工具需要的最小请求形态：一条 user 消息
    const messages = body && body.messages;
    if (!Array.isArray(messages) || messages.length !== 1 || messages[0].role !== "user"
        || typeof messages[0].content !== "string"
        || messages[0].content.length > MAX_PROMPT_CHARS) {
      return json({ error: { message: "请求格式不符合要求" } }, 400);
    }

    const providerName = (env.PROVIDER || "anthropic").toLowerCase().trim();
    const p = PROVIDERS[providerName];
    if (!p) return json({ error: { message: "PROVIDER 配置无效：" + providerName + "。可选：" + Object.keys(PROVIDERS).join(" / ") } }, 500);
    if (!env.API_KEY) return json({ error: { message: "尚未配置 API_KEY（Worker 的 Secret 变量）" } }, 500);
    const model = (env.MODEL || "").trim() || p.model;

    let upstream;
    try {
      if (p.style === "anthropic") {
        upstream = await fetch(p.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model, max_tokens: 1000, messages }),
        });
      } else {
        upstream = await fetch(p.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + env.API_KEY,
          },
          body: JSON.stringify({ model, max_tokens: 1000, messages, temperature: 0.7 }),
        });
      }
    } catch (e) {
      return json({ error: { message: "上游请求失败：" + e.message } }, 502);
    }

    let data;
    try { data = await upstream.json(); }
    catch { return json({ error: { message: "上游返回了无法解析的内容（HTTP " + upstream.status + "）" } }, 502); }

    if (!upstream.ok) {
      // 各家错误结构不同，尽量提取可读信息
      const msg = (data.error && (data.error.message || data.error.msg))
        || data.message || ("上游返回 HTTP " + upstream.status);
      return json({ error: { message: "[" + providerName + "] " + msg } }, upstream.status);
    }

    // 统一响应形状为 { content: [{ type: "text", text }] }，前端无需感知服务商差异
    let text = "";
    if (p.style === "anthropic") {
      text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    } else {
      const choice = data.choices && data.choices[0];
      text = (choice && choice.message && choice.message.content) || "";
      // 兼容推理模型把正文放在 reasoning 之外为空的边缘情况
      if (!text && choice && choice.message && choice.message.reasoning_content) {
        text = choice.message.reasoning_content;
      }
    }
    if (!text) return json({ error: { message: "[" + providerName + "] 模型没有返回文本内容" } }, 502);

    return json({ content: [{ type: "text", text }] });
  },
};
