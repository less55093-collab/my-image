// 异步生图客户端：提交 /images/{generations,edits}/async，轮询 /images/tasks/:id。
// 走异步链路后，网关会把生成的图片转存到对象存储（R2），
// 任务结果里的 data[].url 是存储侧地址而不是上游临时地址。

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_TIMEOUT_MS = 1_000;

export class ImageApiError extends Error {
  constructor(status, body) {
    const message = body?.error?.message || body?.message || `HTTP ${status}`;
    super(message);
    this.name = "ImageApiError";
    this.status = status;
    this.body = body;
  }
}

export function isSizeError(error) {
  const text = JSON.stringify(error?.body || error?.message || error).toLowerCase();
  return text.includes("size") || text.includes("尺寸");
}

export function asyncEndpoint(baseUrl, operation) {
  const suffix = operation === "edit" ? "edits" : "generations";
  if (/\/images\/(?:generations|edits)(\/async)?$/.test(baseUrl)) {
    return baseUrl.replace(/\/images\/(?:generations|edits)(\/async)?$/, `/images/${suffix}/async`);
  }
  return `${baseUrl}/images/${suffix}/async`;
}

export function tasksBaseUrl(baseUrl) {
  return baseUrl.replace(/\/images\/(?:generations|edits)(\/async)?$/, "").replace(/\/$/, "");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readJsonResponse(response) {
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  if (!response.ok) throw new ImageApiError(response.status, body);
  return body;
}

function taskStatus(body) {
  return String(body?.status || "").toLowerCase();
}

function taskError(status, body) {
  const payload = body?.error && typeof body.error === "object" ? { error: body.error } : body;
  const error = new ImageApiError(Number(body?.http_status) || status || 502, payload);
  error.taskFailed = true;
  return error;
}

// 提交异步任务时返回这些状态码，说明该中转站不支持异步端点，应降级同步。
export function isAsyncUnsupported(error) {
  if (!(error instanceof ImageApiError)) return false;
  if ([404, 405, 501].includes(error.status)) return true;
  const text = JSON.stringify(error.body || "").toLowerCase();
  return error.status === 400 && text.includes("async") && text.includes("not");
}

export async function callSyncImageApi({ endpoint, apiKey, json, form, timeoutMs }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let body;
  if (form) {
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(Math.max(Number(timeoutMs) || 0, MIN_TIMEOUT_MS)),
  });
  return readJsonResponse(response);
}

export function syncEndpoint(baseUrl, operation) {
  const suffix = operation === "edit" ? "edits" : "generations";
  if (/\/images\/(?:generations|edits)(\/async)?$/.test(baseUrl)) {
    return baseUrl.replace(/\/images\/(?:generations|edits)(\/async)?$/, `/images/${suffix}`);
  }
  return `${baseUrl}/images/${suffix}`;
}

export async function submitAsyncTask({ endpoint, apiKey, json, form, timeoutMs }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let body;
  if (form) {
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const submitTimeout = Math.max(Number(timeoutMs) || 0, 60_000, MIN_TIMEOUT_MS);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(submitTimeout),
  });
  const result = await readJsonResponse(response);
  const taskId = result.task_id || result.id;
  if (!taskId) throw new ImageApiError(response.status, { message: "异步接口响应中没有 task_id", raw: result });
  return { taskId, raw: result };
}

export async function pollAsyncTask({ baseUrl, apiKey, taskId, timeoutMs, intervalMs = DEFAULT_POLL_INTERVAL_MS }) {
  const deadline = Date.now() + Math.max(Number(timeoutMs) || 0, MIN_TIMEOUT_MS);
  const url = `${tasksBaseUrl(baseUrl)}/images/tasks/${encodeURIComponent(taskId)}`;
  let lastError = null;
  for (;;) {
    if (Date.now() >= deadline) {
      const error = new Error(`等待生图任务超时（${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s 内未完成）`);
      error.code = "TASK_TIMEOUT";
      error.taskId = taskId;
      throw error;
    }
    let body = null;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(Math.min(30_000, Math.max(deadline - Date.now(), MIN_TIMEOUT_MS))),
      });
      body = await readJsonResponse(response);
      lastError = null;
    } catch (error) {
      // 轮询阶段的瞬时网络/5xx 错误不打断等待，任务在服务端仍在执行。
      lastError = error;
    }
    if (body) {
      const status = taskStatus(body);
      if (status === "completed" || status === "succeeded" || status === "success") {
        const result = body.result || body;
        if (!Array.isArray(result.data)) {
          throw new ImageApiError(502, { message: "任务完成但结果中没有 data 数组", raw: body });
        }
        return { result, task: body };
      }
      if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
        throw taskError(502, body);
      }
    }
    await sleep(intervalMs);
  }
}

export async function callAsyncImageApi({ endpoint, baseUrl, apiKey, json, form, timeoutMs, intervalMs }) {
  const { taskId } = await submitAsyncTask({ endpoint, apiKey, json, form, timeoutMs });
  const { result } = await pollAsyncTask({ baseUrl, apiKey, taskId, timeoutMs, intervalMs });
  return result;
}
