import { requestCompletion } from "./api-client.js";
import { generateChallenges } from "./challenge-browser.js";
import { analyzeGlobalOutputs, parseNumbers } from "./fingerprint-core.js";

const TARGET_VALID = 3;
const MAX_ATTEMPTS = 6;

export async function runApiTest(config, {
  bank,
  signal,
  onProgress = () => {},
  request = requestCompletion,
  challenges = generateChallenges(MAX_ATTEMPTS),
} = {}) {
  if (!bank || !Array.isArray(bank.models) || !bank.models.length) {
    throw new Error("指纹库尚未加载，请等待加载完成后再开始测试。");
  }
  const selected = challenges.slice(0, MAX_ATTEMPTS);
  const steps = selected.map(() => ({ status: "pending", count: 0, message: "等待中" }));
  const outputs = [];
  const errors = [];
  let valid = 0;
  let attempted = 0;
  let cancelled = Boolean(signal?.aborted);
  const publish = () => onProgress({ steps: steps.map(step => ({ ...step })), valid, attempted });
  publish();

  for (let index = 0; index < selected.length && valid < TARGET_VALID; index += 1) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const challenge = selected[index];
    const step = steps[index];
    step.status = "working";
    step.message = "请求中";
    attempted += 1;
    publish();
    let response;
    try {
      response = await request(config, challenge.prompt, { signal });
    } catch (error) {
      if (signal?.aborted) {
        cancelled = true;
        step.status = "cancelled";
        step.message = "已停止";
      } else {
        step.status = "error";
        // The API client exposes only fixed, sanitized messages.
        step.message = error?.message || "API 请求失败，请检查接口设置后手动重试。";
        errors.push(step.message);
      }
      publish();
      break;
    }
    if (signal?.aborted) {
      cancelled = true;
      step.status = "cancelled";
      step.message = "已停止";
      publish();
      break;
    }

    // Preserve every response, including invalid ones, in request order. The
    // original scorer uses array positions as diagnostic challenge indices.
    outputs.push({ text: response.text, expected_count: challenge.expected_count });
    step.count = parseNumbers(response.text).length;
    const minimum = Math.max(80, Math.ceil(Number(challenge.expected_count || 0) * 0.55));
    if (step.count >= minimum) {
      valid += 1;
      step.status = "done";
      step.message = `${step.count} 个数字 · 有效`;
    } else {
      step.status = "invalid";
      step.message = `${step.count} 个数字 · 数量不足（至少 ${minimum} 个）`;
    }
    publish();
  }

  cancelled = cancelled || Boolean(signal?.aborted);
  steps.forEach(step => {
    if (step.status === "pending") {
      step.status = "skipped";
      step.message = "无需调用";
    }
  });
  const payload = valid > 0 ? analyzeGlobalOutputs(outputs, bank) : null;
  publish();
  return { payload, steps, outputs, errors, cancelled };
}
