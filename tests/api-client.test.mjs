import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../static/api-client.js", import.meta.url), "utf8");
const { normalizeConfig, requestCompletion } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const baseConfig = { baseUrl: "https://api.example.test", apiKey: "secret-test-only", model: "example-model" };
const responseFor = (data) => ({ ok: true, status: 200, json: async () => data });
const chatResponse = { choices: [{ message: { content: "1, 2, 3" }, finish_reason: "stop" }] };

test("normalization handles root, versioned paths, custom paths, and explicit endpoint switching", () => {
  const cases = [
    ["https://api.example.test", "chat", "https://api.example.test/v1/chat/completions"],
    ["https://api.example.test/v1/", "responses", "https://api.example.test/v1/responses"],
    ["https://api.example.test/custom/route/", "completions", "https://api.example.test/custom/route/completions"],
    ["https://api.example.test/custom/v1/chat/completions/", "responses", "https://api.example.test/custom/v1/responses"],
    ["https://api.example.test/v1/responses", "completions", "https://api.example.test/v1/completions"],
    ["https://api.example.test/v1/completions", "chat", "https://api.example.test/v1/chat/completions"],
    ["https://api.example.test/responses", "chat", "https://api.example.test/chat/completions"],
    ["http://localhost:8080", "responses", "http://localhost:8080/v1/responses"],
    ["http://127.0.0.1:8080/v1", "chat", "http://127.0.0.1:8080/v1/chat/completions"],
    ["http://[::1]:8080/v1", "chat", "http://[::1]:8080/v1/chat/completions"],
  ];
  for (const [baseUrl, format, expected] of cases) {
    const config = normalizeConfig({ ...baseConfig, baseUrl, format });
    assert.equal(config.endpoint, expected);
    assert.deepEqual(normalizeConfig(config), config, "normalization is idempotent");
  }
  assert.equal(normalizeConfig(baseConfig).timeoutMs, 180000);
  assert.equal(normalizeConfig(baseConfig).format, "chat");
});

test("unsafe URLs and invalid settings are rejected without leaking input", () => {
  const unsafeUrls = [
    "http://api.example.test/v1", "http://localhost.evil.test", "ftp://api.example.test",
    "https://secret-user:secret-password@api.example.test/v1", "https://api.example.test/v1?key=secret",
    "https://api.example.test/v1?", "https://api.example.test/v1#", "https://api.example.test/v1#secret",
    "https://api.example.test\\secret", "https://api.example.test/a\nb", "not-a-url", "",
  ];
  for (const baseUrl of unsafeUrls) {
    assert.throws(() => normalizeConfig({ ...baseConfig, baseUrl }), error => {
      assert.equal(error.code, "CONFIG");
      assert.doesNotMatch(error.message, /secret|evil|example\.test/);
      return true;
    });
  }
  for (const patch of [
    { apiKey: "" }, { apiKey: "secret\nkey" }, { model: "" }, { model: "model\nname" },
    { format: "auto" }, { format: "toString" }, { temperature: -1 }, { temperature: 2.1 },
    { temperature: "no" }, { temperature: true }, { timeoutMs: 0 }, { timeoutMs: Infinity },
  ]) assert.throws(() => normalizeConfig({ ...baseConfig, ...patch }), { code: "CONFIG" });
  for (const temperature of [undefined, "", "  ", null]) {
    assert.equal(normalizeConfig({ ...baseConfig, temperature }).temperature, undefined);
  }
  assert.equal(normalizeConfig({ ...baseConfig, temperature: "0" }).temperature, 0);
});

test("all protocol requests use the selected endpoint, safe fetch options and no unnecessary parameters", async () => {
  const protocols = [
    ["responses", { input: "test prompt", store: false }, { output: [{ type: "message", content: [{ type: "output_text", text: "1, 2, 3" }] }] }],
    ["chat", { messages: [{ role: "user", content: "test prompt" }] }, chatResponse],
    ["completions", { prompt: "test prompt" }, { choices: [{ text: "1, 2, 3" }] }],
  ];
  for (const [format, expectedBody, payload] of protocols) {
    let calls = 0;
    const result = await requestCompletion({ ...baseConfig, format }, "test prompt", {
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, normalizeConfig({ ...baseConfig, format }).endpoint);
        assert.equal(options.method, "POST");
        assert.deepEqual(options.headers, { "Content-Type": "application/json", Authorization: "Bearer secret-test-only" });
        assert.deepEqual(JSON.parse(options.body), { model: "example-model", stream: false, ...expectedBody });
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        assert.equal(options.referrerPolicy, "no-referrer");
        assert.equal(options.cache, "no-store");
        assert.ok(options.signal instanceof AbortSignal);
        return responseFor(payload);
      },
    });
    assert.deepEqual(result, { text: "1, 2, 3", format });
    assert.equal(calls, 1);
  }
});

test("temperature zero is sent only when explicitly configured", async () => {
  await requestCompletion({ ...baseConfig, temperature: 0 }, "test prompt", {
    fetchImpl: async (_, options) => {
      assert.equal(JSON.parse(options.body).temperature, 0);
      return responseFor(chatResponse);
    },
  });
});

test("Responses extracts final output_text only, ignoring reasoning and tool outputs", async () => {
  const data = {
    status: "completed",
    output_text: "untrusted convenience field",
    output: [
      { type: "reasoning", content: [{ type: "output_text", text: "999" }] },
      { type: "function_call", content: [{ type: "output_text", text: "888" }] },
      { type: "message", content: [{ type: "output_text", text: "1, 2" }, { type: "reasoning", text: "777" }] },
      { type: "message", content: [{ type: "output_text", text: "3, 4" }] },
    ],
  };
  assert.deepEqual(await requestCompletion({ ...baseConfig, format: "responses" }, "test", { fetchImpl: async () => responseFor(data) }), {
    text: "1, 2\n3, 4", format: "responses",
  });
});

test("Chat Completions selects the first choice and accepts text content blocks", async () => {
  const data = { choices: [
    { message: { content: [{ type: "text", text: "1, 2" }, { type: "reasoning", text: "999" }, { type: "text", text: "3" }] } },
    { message: { content: "888" } },
  ] };
  assert.equal((await requestCompletion(baseConfig, "test", { fetchImpl: async () => responseFor(data) })).text, "1, 2\n3");
});

test("HTTP failures never read or leak response bodies and never retry", async () => {
  for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(requestCompletion(baseConfig, "test", { fetchImpl: async () => {
      calls += 1;
      return { ok: false, status, json: () => { throw new Error("MUST NOT READ secret-test-only"); } };
    } }), error => {
      assert.equal(error.code, "HTTP");
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(String(status)));
      assert.doesNotMatch(error.message, /secret-test-only|MUST NOT READ/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("network/CORS and JSON errors are actionable and sanitized", async () => {
  await assert.rejects(requestCompletion(baseConfig, "test", { fetchImpl: async () => { throw new Error("secret-test-only"); } }), error => {
    assert.equal(error.code, "NETWORK");
    assert.match(error.message, /CORS/);
    assert.doesNotMatch(error.message, /secret-test-only/);
    return true;
  });
  await assert.rejects(requestCompletion(baseConfig, "test", { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("secret-test-only"); } }) }), { code: "NON_JSON" });
});

test("API errors, refusal, incomplete and empty responses cannot become valid test text", async () => {
  const cases = [
    ["chat", { error: { message: "secret-test-only" } }, "API_ERROR"],
    ["responses", { status: "failed", output: [] }, "API_ERROR"],
    ["responses", { status: "incomplete", output: [] }, "INCOMPLETE"],
    ["responses", { output: [{ type: "message", status: "incomplete", content: [] }] }, "INCOMPLETE"],
    ["responses", { output: [{ type: "message", content: [{ type: "refusal", refusal: "secret-test-only" }] }] }, "REFUSAL"],
    ["chat", { choices: [{ message: { refusal: "secret-test-only" } }] }, "REFUSAL"],
    ["chat", { choices: [{ finish_reason: "content_filter", message: { content: "1, 2" } }] }, "REFUSAL"],
    ["chat", { choices: [{ finish_reason: "length", message: { content: "1, 2" } }] }, "INCOMPLETE"],
    ["completions", { choices: [{ finish_reason: "length", text: "1, 2" }] }, "INCOMPLETE"],
    ["chat", { choices: [] }, "EMPTY_RESPONSE"],
    ["responses", { output: [{ type: "reasoning", content: [{ type: "output_text", text: "123" }] }] }, "EMPTY_RESPONSE"],
    ["completions", { choices: [{ text: " " }] }, "EMPTY_RESPONSE"],
    ["chat", null, "INVALID_RESPONSE"],
  ];
  for (const [format, payload, code] of cases) {
    await assert.rejects(requestCompletion({ ...baseConfig, format }, "test", { fetchImpl: async () => responseFor(payload) }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret-test-only/);
      return true;
    });
  }
});

test("a pre-aborted request makes no network call", async () => {
  const controller = new AbortController();
  controller.abort("secret-test-only");
  await assert.rejects(requestCompletion(baseConfig, "test", {
    signal: controller.signal,
    fetchImpl: () => assert.fail("must not fetch"),
  }), { name: "AbortError", code: "ABORTED", message: "测试已停止。" });
});

test("user cancellation stops both fetching and response decoding even when transport ignores its signal", async () => {
  for (const stage of ["fetch", "json"]) {
    const controller = new AbortController();
    let requestSignal;
    let reached;
    const started = new Promise(resolve => { reached = resolve; });
    const pending = requestCompletion(baseConfig, "test", {
      signal: controller.signal,
      fetchImpl: async (_, options) => {
        requestSignal = options.signal;
        if (stage === "fetch") {
          reached();
          return new Promise(() => {});
        }
        return { ok: true, json: () => { reached(); return new Promise(() => {}); } };
      },
    });
    await started;
    controller.abort("secret-test-only");
    await assert.rejects(pending, { code: "ABORTED", name: "AbortError" });
    assert.equal(requestSignal.aborted, true);
  }
});

test("timeout covers both fetching and response decoding and does not retry", async () => {
  for (const stage of ["fetch", "json"]) {
    let calls = 0;
    let requestSignal;
    await assert.rejects(requestCompletion({ ...baseConfig, timeoutMs: 10 }, "test", {
      fetchImpl: async (_, options) => {
        calls += 1;
        requestSignal = options.signal;
        return stage === "fetch" ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) };
      },
    }), { code: "TIMEOUT", name: "TimeoutError" });
    assert.equal(calls, 1);
    assert.equal(requestSignal.aborted, true);
  }
});

test("abort listeners are removed when requests finish", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added += 1; originalAdd(...args); };
  signal.removeEventListener = (...args) => { removed += 1; originalRemove(...args); };
  await requestCompletion(baseConfig, "test", { signal, fetchImpl: async () => responseFor(chatResponse) });
  assert.equal(added, 1);
  assert.equal(removed, 1);
});
