import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrls = new Map();
async function browserModuleUrl(filename) {
  if (moduleUrls.has(filename)) return moduleUrls.get(filename);
  let source = await readFile(new URL(`../static/${filename}`, import.meta.url), "utf8");
  for (const dependency of [...source.matchAll(/from "\.\/([^\"]+)"/g)]) {
    source = source.replace(dependency[0], `from "${await browserModuleUrl(dependency[1])}"`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  moduleUrls.set(filename, url);
  return url;
}
const { runApiTest } = await import(await browserModuleUrl("api-runner.js"));
const { analyzeGlobalOutputs } = await import(await browserModuleUrl("fingerprint-core.js"));
const bank = JSON.parse(await readFile(new URL("../data/unified_bank.json", import.meta.url), "utf8"));
const references = (await readFile(new URL("../data/gpt_reference.jsonl", import.meta.url), "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
const saved = references.filter(row => row.strict_valid).slice(0, 3);
assert.equal(saved.length, 3);
const config = { baseUrl: "https://api.example.test", apiKey: "mock-only", model: "example-model" };
const numbers = (count) => Array.from({ length: count }, (_, index) => 1 + ((index * 97 + 23) % 355)).join(", ");
const challenges = Array.from({ length: 6 }, (_, index) => ({ prompt: `challenge-${index + 1}`, expected_count: 300 }));

function queueRequest(texts, calls = []) {
  return async (receivedConfig, prompt, options) => {
    assert.equal(receivedConfig, config);
    assert.ok(Object.hasOwn(options, "signal"));
    calls.push(prompt);
    const next = texts[calls.length - 1];
    assert.notEqual(next, undefined, "runner made an unexpected extra API call");
    if (next instanceof Error) throw next;
    return { text: next, format: "chat" };
  };
}

test("three valid saved references stop early and keep the original analysis unchanged", async () => {
  const calls = [];
  const customChallenges = challenges.map((challenge, index) => ({ ...challenge, expected_count: saved[index % 3].requested_count }));
  const result = await runApiTest(config, {
    bank,
    challenges: customChallenges,
    request: queueRequest(saved.map(row => row.text), calls),
  });
  assert.deepEqual(calls, ["challenge-1", "challenge-2", "challenge-3"]);
  assert.deepEqual(result.steps.map(step => step.status), ["done", "done", "done", "skipped", "skipped", "skipped"]);
  assert.equal(result.payload.used_outputs, 3);
  assert.equal(result.outputs.length, 3);
  assert.deepEqual(result.errors, []);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.payload, analyzeGlobalOutputs(saved.map(row => ({ text: row.text, expected_count: row.requested_count })), bank));
});

test("invalid responses trigger supplemental challenges and keep diagnostic indices aligned", async () => {
  const calls = [];
  const texts = [numbers(164), numbers(165), "没有回答", numbers(300), numbers(170)];
  const result = await runApiTest(config, { bank, challenges, request: queueRequest(texts, calls) });
  assert.equal(calls.length, 5);
  assert.deepEqual(result.steps.map(step => step.status), ["invalid", "done", "invalid", "done", "done", "skipped"]);
  assert.deepEqual(result.outputs.map(output => output.text), texts);
  assert.deepEqual(result.payload.diagnostics.map(item => [item.index, item.accepted]), [[0, false], [1, true], [2, false], [3, true], [4, true]]);
  assert.deepEqual(result.payload.diagnostics.map(item => item.parsed_numbers), result.steps.slice(0, 5).map(step => step.count));
  assert.equal(result.payload.used_outputs, 3);
});

test("six attempts are the hard limit even when additional supplied challenges exist", async () => {
  const calls = [];
  const result = await runApiTest(config, {
    bank,
    challenges: [...challenges, { prompt: "must not run", expected_count: 300 }],
    request: queueRequest([numbers(300), "short", "short", "short", "short", numbers(300)], calls),
  });
  assert.equal(calls.length, 6);
  assert.equal(result.steps.length, 6);
  assert.equal(result.outputs.length, 6);
  assert.equal(result.payload.used_outputs, 2);
  assert.equal(result.payload.diagnostics.length, 6);
});

test("the 80-number floor and ceiling of 55 percent match the scorer", async () => {
  const result = await runApiTest(config, {
    bank,
    challenges: [
      { prompt: "below-floor", expected_count: 100 }, { prompt: "at-floor", expected_count: 100 },
      { prompt: "below-ceiling", expected_count: 301 }, { prompt: "at-ceiling", expected_count: 301 },
    ],
    request: queueRequest([numbers(79), numbers(80), numbers(165), numbers(166)]),
  });
  assert.deepEqual(result.steps.map(step => step.status), ["invalid", "done", "invalid", "done"]);
  assert.deepEqual(result.payload.diagnostics.map(item => item.minimum_numbers), [80, 80, 166, 166]);
});

test("an authentication failure stops immediately with no retries", async () => {
  const calls = [];
  const error = new Error("API 认证失败（HTTP 401）。请检查 API Key 是否正确或已过期。");
  const result = await runApiTest(config, { bank, challenges, request: queueRequest([error], calls) });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.steps.map(step => step.status), ["error", "skipped", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal(result.payload, null);
  assert.deepEqual(result.outputs, []);
  assert.deepEqual(result.errors, [error.message]);
  assert.equal(result.cancelled, false);
});

test("a later interface failure preserves earlier valid and invalid outputs", async () => {
  const calls = [];
  const result = await runApiTest(config, {
    bank, challenges,
    request: queueRequest(["short", numbers(300), new Error("API 请求受限（HTTP 429）。")], calls),
  });
  assert.equal(calls.length, 3);
  assert.equal(result.outputs.length, 2);
  assert.equal(result.payload.used_outputs, 1);
  assert.deepEqual(result.payload.diagnostics.map(item => [item.index, item.accepted]), [[0, false], [1, true]]);
  assert.deepEqual(result.steps.map(step => step.status), ["invalid", "done", "error", "skipped", "skipped", "skipped"]);
  assert.equal(result.errors.length, 1);
});

test("cancellation during a request preserves a partial result and marks unused steps skipped", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runApiTest(config, {
    bank, challenges, signal: controller.signal,
    request: async (_, __, { signal }) => {
      assert.equal(signal, controller.signal);
      calls += 1;
      if (calls === 1) return { text: numbers(300) };
      controller.abort();
      throw new DOMException("stop", "AbortError");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.payload.used_outputs, 1);
  assert.deepEqual(result.steps.map(step => step.status), ["done", "cancelled", "skipped", "skipped", "skipped", "skipped"]);
});

test("a response arriving after cancellation is discarded", async () => {
  const controller = new AbortController();
  const result = await runApiTest(config, {
    bank, challenges, signal: controller.signal,
    request: async () => { controller.abort(); return { text: numbers(300) }; },
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.payload, null);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.steps[0].status, "cancelled");
});

test("a pre-aborted signal never sends a request", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runApiTest(config, {
    bank, challenges, signal: controller.signal,
    request: () => assert.fail("must not request"),
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.payload, null);
  assert.ok(result.steps.every(step => step.status === "skipped"));
});

test("no valid answers returns a null payload with all attempts and invalid outputs retained", async () => {
  const calls = [];
  const result = await runApiTest(config, { bank, challenges, request: queueRequest(Array(6).fill("short"), calls) });
  assert.equal(calls.length, 6);
  assert.equal(result.outputs.length, 6);
  assert.equal(result.payload, null);
  assert.ok(result.steps.every(step => step.status === "invalid"));
  assert.deepEqual(result.errors, []);
});

test("progress is emitted at each transition with independent snapshots and accurate counts", async () => {
  const snapshots = [];
  const result = await runApiTest(config, {
    bank, challenges, request: queueRequest([numbers(300), numbers(300), numbers(300)]),
    onProgress: snapshot => {
      snapshots.push({ ...snapshot, steps: snapshot.steps.map(step => ({ ...step })) });
      // A subscriber must not be able to mutate the runner's internal steps.
      snapshot.steps[0].status = "subscriber-mutation";
    },
  });
  assert.deepEqual(snapshots.map(({ valid, attempted }) => [valid, attempted]), [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [3, 3]]);
  assert.equal(snapshots[0].steps[0].status, "pending");
  assert.equal(snapshots[1].steps[0].status, "working");
  assert.equal(snapshots[2].steps[0].status, "done");
  assert.equal(snapshots.at(-1).steps[5].status, "skipped");
  assert.equal(result.steps[0].status, "done");
});

test("cancellation between requests does not increment attempts or start another call", async () => {
  const controller = new AbortController();
  const snapshots = [];
  const calls = [];
  const result = await runApiTest(config, {
    bank, challenges, signal: controller.signal, request: queueRequest([numbers(300)], calls),
    onProgress: snapshot => {
      snapshots.push(snapshot);
      if (snapshot.valid === 1) controller.abort();
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.payload.used_outputs, 1);
  assert.equal(result.cancelled, true);
  assert.equal(snapshots.at(-1).attempted, 1);
  assert.deepEqual(result.steps.map(step => step.status), ["done", "skipped", "skipped", "skipped", "skipped", "skipped"]);
});

test("missing fingerprint bank is rejected before any API call", async () => {
  await assert.rejects(runApiTest(config, {
    challenges,
    request: () => assert.fail("must not request without a bank"),
  }), /指纹库尚未加载/);
});
