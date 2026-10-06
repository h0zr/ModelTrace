// Browser-only transport. Credentials stay in memory and are sent only to the
// configured endpoint; errors never include request credentials or response text.
const ENDPOINTS = Object.freeze({
  responses: "/responses",
  chat: "/chat/completions",
  completions: "/completions",
});
const DEFAULT_TIMEOUT_MS = 180000;

function clientError(code, message, status) {
  const error = new Error(message);
  error.name = code === "ABORTED" ? "AbortError" : code === "TIMEOUT" ? "TimeoutError" : "ApiClientError";
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function endpointFor(value, format) {
  if (typeof value !== "string" || !value.trim()) {
    throw clientError("CONFIG", "请填写 API Base URL。");
  }
  const input = value.trim();
  // Reject even empty query/fragment delimiters, as URL.search/hash omit those.
  if (/[?#\u0000-\u0020\u007f\\]/.test(input)) {
    throw clientError("CONFIG", "Base URL 不能包含查询参数、片段、空白或反斜杠。");
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw clientError("CONFIG", "Base URL 无效，请填写包含 https:// 的完整地址。");
  }
  const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw clientError("CONFIG", "API 地址必须使用 HTTPS；本机 localhost 或回环地址可使用 HTTP。");
  }
  if (url.username || url.password) {
    throw clientError("CONFIG", "Base URL 不能包含用户名或密码，请在 API Key 栏填写密钥。");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const knownEndpoint = /\/(?:chat\/completions|responses|completions)$/.test(path);
  const basePath = knownEndpoint
    ? path.replace(/\/(?:chat\/completions|responses|completions)$/, "")
    : path || "/v1";
  // Keep explicit endpoint inputs intact so a root-level /responses remains
  // root-level when this normalized configuration is validated a second time.
  return {
    baseUrl: url.origin + (knownEndpoint ? path : basePath),
    endpoint: url.origin + basePath + ENDPOINTS[format],
  };
}

export function normalizeConfig(config = {}) {
  if (!config || typeof config !== "object") {
    throw clientError("CONFIG", "API 配置无效，请检查输入。");
  }
  const format = config.format ?? "chat";
  if (!Object.hasOwn(ENDPOINTS, format)) {
    throw clientError("CONFIG", "请选择 Responses、Chat Completions 或 Completions 接口。");
  }
  const urls = endpointFor(config.baseUrl, format);
  if (typeof config.apiKey !== "string" || !config.apiKey.trim()) {
    throw clientError("CONFIG", "请填写 API Key。");
  }
  const apiKey = config.apiKey.trim();
  if (/[\u0000-\u0020\u007f]/.test(apiKey)) {
    throw clientError("CONFIG", "API Key 不能包含空格或换行，请检查后重新粘贴。");
  }
  if (typeof config.model !== "string" || !config.model.trim() || /[\u0000-\u001f\u007f]/.test(config.model)) {
    throw clientError("CONFIG", "请填写有效的接口模型名。");
  }
  let temperature;
  if (config.temperature !== undefined && config.temperature !== null && String(config.temperature).trim() !== "") {
    temperature = Number(config.temperature);
    if (!["string", "number"].includes(typeof config.temperature) || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw clientError("CONFIG", "温度必须在 0 到 2 之间，或留空使用接口默认值。");
    }
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw clientError("CONFIG", "请求超时必须为正整数毫秒。");
  }
  return Object.freeze({ ...urls, apiKey, model: config.model.trim(), format, temperature, timeoutMs });
}

function httpError(status) {
  const messages = {
    400: "API 拒绝了请求（HTTP 400）。请检查模型名、接口类型和温度设置。",
    401: "API 认证失败（HTTP 401）。请检查 API Key 是否正确或已过期。",
    403: "API 拒绝访问（HTTP 403）。请检查密钥权限及该模型的访问权限。",
    404: "API 地址或模型不存在（HTTP 404）。请检查 Base URL、接口类型和模型名。",
    408: "API 请求超时（HTTP 408）。请稍后手动重试。",
    429: "API 请求受限（HTTP 429）。请检查额度或等待限流恢复后手动重试。",
  };
  const message = messages[status] || (status >= 500
    ? `API 服务暂时不可用（HTTP ${status}）。请稍后手动重试。`
    : `API 请求失败（HTTP ${status}）。请检查接口设置。`);
  return clientError("HTTP", message, status);
}

function extractText(data, format) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw clientError("INVALID_RESPONSE", "API 返回结构不符合所选接口，请检查接口类型。");
  }
  if (data.error || data.status === "failed") {
    throw clientError("API_ERROR", "API 返回错误。请检查模型名、密钥权限和额度，并在服务商控制台查看详情。");
  }
  if (["incomplete", "cancelled", "queued", "in_progress"].includes(data.status)) {
    throw clientError("INCOMPLETE", "API 未完成本次回答，请检查模型限制后手动重试。");
  }
  let text = "";
  if (format === "responses") {
    const messages = Array.isArray(data.output) ? data.output.filter(item => item?.type === "message") : [];
    if (messages.some(message => message.status === "incomplete")) {
      throw clientError("INCOMPLETE", "API 返回了不完整的回答，请检查模型限制后手动重试。");
    }
    const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    if (parts.some(part => part?.type === "refusal")) {
      throw clientError("REFUSAL", "模型拒绝了本次测试请求，请检查模型或服务商的使用限制。");
    }
    text = parts.filter(part => part?.type === "output_text" && typeof part.text === "string").map(part => part.text).join("\n");
  } else {
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (choice?.finish_reason === "length") {
      throw clientError("INCOMPLETE", "API 回答因长度限制而截断，请检查模型限制后手动重试。");
    }
    if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) {
      throw clientError("REFUSAL", "模型拒绝了本次测试请求，请检查模型或服务商的使用限制。");
    }
    if (format === "completions") {
      text = typeof choice?.text === "string" ? choice.text : "";
    } else if (typeof choice?.message?.content === "string") {
      text = choice.message.content;
    } else if (Array.isArray(choice?.message?.content)) {
      text = choice.message.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
    }
  }
  if (!text.trim()) {
    throw clientError("EMPTY_RESPONSE", "API 未返回可用于测试的文本。请检查接口类型、模型设置，或确认模型返回最终回答。");
  }
  return text.trim();
}

export async function requestCompletion(config, prompt, { signal, fetchImpl = fetch } = {}) {
  const normalized = normalizeConfig(config);
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw clientError("PROMPT", "测试提示词不能为空。");
  }
  if (signal?.aborted) throw clientError("ABORTED", "测试已停止。");

  const controller = new AbortController();
  let timer;
  let abortListener;
  let interruption;
  // Race the whole operation, including body decoding. Some transports and
  // mocks do not reject promptly when only the fetch signal is aborted.
  const interrupted = new Promise((_, reject) => {
    const stop = (error) => {
      if (interruption) return;
      interruption = error;
      controller.abort();
      reject(error);
    };
    abortListener = () => stop(clientError("ABORTED", "测试已停止。"));
    signal?.addEventListener("abort", abortListener, { once: true });
    timer = setTimeout(() => stop(clientError("TIMEOUT", "API 请求超时。请检查网络和服务商状态后手动重试。")), normalized.timeoutMs);
  });

  const body = { model: normalized.model, stream: false };
  if (normalized.temperature !== undefined) body.temperature = normalized.temperature;
  if (normalized.format === "responses") {
    body.input = prompt;
    body.store = false;
  } else if (normalized.format === "chat") {
    body.messages = [{ role: "user", content: prompt }];
  } else {
    body.prompt = prompt;
  }

  try {
    const operation = (async () => {
      let response;
      try {
        response = await fetchImpl(normalized.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${normalized.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
        });
      } catch {
        if (interruption) throw interruption;
        throw clientError("NETWORK", "无法连接 API。请检查地址和网络，并确认服务商允许此网页的跨域请求（CORS）；重定向地址也会被拒绝。");
      }
      if (interruption) throw interruption;
      if (!response.ok) throw httpError(response.status);
      let data;
      try {
        data = await response.json();
      } catch {
        if (interruption) throw interruption;
        throw clientError("NON_JSON", "API 未返回有效 JSON。请检查 Base URL 是否指向 API 接口，以及接口类型是否正确。");
      }
      if (interruption) throw interruption;
      return { text: extractText(data, normalized.format), format: normalized.format };
    })();
    return await Promise.race([operation, interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortListener);
  }
}
