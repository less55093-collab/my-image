#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchModels, getConfigPath, loadConfig, normalizeBaseUrl, probeConnection, saveConfig, sortModelsForImages } from "./verify-config.mjs";

function parseArgs(argv) {
  const options = { noOpen: false, stdinJson: false, skipVerify: false, timeoutMs: 600_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--stdin-json") options.stdinJson = true;
    else if (arg === "--skip-verify") options.skipVerify = true;
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms 必须是不小于 1000 的整数");
  }
  return options;
}

async function readStdin() {
  let content = "";
  for await (const chunk of process.stdin) content += chunk;
  return content;
}

function applyWindowsAcl(configPath) {
  if (platform() !== "win32") return [];
  const username = process.env.USERNAME;
  if (!username) return ["未找到 Windows 用户名，无法自动收紧配置文件 ACL"];

  const result = spawnSync(
    "icacls",
    [configPath, "/inheritance:r", "/grant:r", `${username}:(F)`],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0 ? [] : ["无法自动收紧 Windows 配置文件 ACL"];
}

async function save(values, { skipVerify = false } = {}) {
  let baseUrl = normalizeBaseUrl(values.baseUrl ?? values.OPENAI_BASE_URL);
  const apiKey = String(values.apiKey ?? values.OPENAI_API_KEY ?? "").trim();
  let model = String(values.model ?? values.IMAGE_MODEL ?? "").trim() || "gpt-image-2.5";
  if (!apiKey) throw new Error("API Key 不能为空");

  let verification = { verified: false, skipped: true };
  if (!skipVerify) {
    verification = await probeConnection({ baseUrl, apiKey, model });
    baseUrl = verification.baseUrl;
    model = verification.model;
  }

  const result = await saveConfig({
    baseUrl,
    apiKey,
    model,
    defaultSize: values.defaultSize ?? values.IMAGE_SIZE ?? "auto",
    mode: values.mode ?? values.IMAGE_MODE ?? "auto",
    timeoutMs: values.timeoutMs ?? values.TIMEOUT_MS ?? 300_000,
  });
  return { ...result, verification, warnings: [...verificationWarnings(values, verification), ...applyWindowsAcl(result.configPath)] };
}

function verificationWarnings(values, verification) {
  if (verification.skipped) return [];
  if (!verification.verified) return [`未能验证连接（${verification.error}），已按填写内容保存`];
  const warnings = [];
  const typedBaseUrl = normalizeBaseUrl(values.baseUrl ?? values.OPENAI_BASE_URL);
  if (verification.baseUrl !== typedBaseUrl) warnings.push(`Base URL 已自动修正为 ${verification.baseUrl}`);
  if (verification.changed) warnings.push(`上游没有默认模型，已改用 ${verification.model}`);
  if (verification.unlisted) warnings.push(`上游模型列表中没有 ${verification.model}，已按填写内容保存`);
  return warnings;
}

function printSaved(result) {
  console.log(`MY_IMAGE_CONFIG_SAVED=${result.configPath}`);
  console.log(`MY_IMAGE_CONFIG_VERIFIED=${result.verification.verified ? "1" : "0"}`);
  console.log(`MY_IMAGE_BASE_URL=${result.baseUrl}`);
  console.log(`MY_IMAGE_MODEL=${result.model}`);
  for (const warning of result.warnings) console.log(`MY_IMAGE_WARNING=${warning}`);
}

function openBrowser(url) {
  try {
    if (platform() === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform() === "win32") {
      spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function htmlPage(token, configPath, nonce, existing) {
  const safePath = configPath.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My Image 配置</title>
  <style>
    :root { color-scheme: light; --ink: #142019; --muted: #627067; --line: #cbd5cd; --paper: #f7faf7; --accent: #0b6b47; --accent-hover: #07563a; --error: #a33131; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 15% 10%, #e1efe5 0, transparent 35%), linear-gradient(145deg, #f5f8f4, #e8eee9); color: var(--ink); font-family: "Avenir Next", "Segoe UI Variable", "Microsoft YaHei", sans-serif; }
    main { width: min(100%, 560px); background: rgba(255,255,255,.94); border: 1px solid rgba(135,154,141,.45); border-radius: 8px; box-shadow: 0 22px 70px rgba(31,54,39,.13); padding: clamp(24px, 5vw, 42px); }
    h1 { margin: 0 0 8px; font-family: Georgia, "Songti SC", serif; font-size: clamp(30px, 7vw, 44px); line-height: 1.05; letter-spacing: 0; }
    p { margin: 0 0 28px; color: var(--muted); line-height: 1.65; }
    label { display: block; margin: 18px 0 7px; font-weight: 650; }
    input { width: 100%; min-height: 46px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; outline: none; }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(11,107,71,.12); }
    .key-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .icon-button { width: 46px; min-height: 46px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); font-size: 20px; cursor: pointer; }
    .icon-button:hover { background: var(--paper); }
    .hint { margin-top: 7px; color: var(--muted); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
    button[type="submit"] { width: 100%; min-height: 48px; margin-top: 26px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font: 700 16px/1 inherit; cursor: pointer; }
    button[type="submit"]:hover { background: var(--accent-hover); }
    button:disabled { cursor: wait; opacity: .62; }
    #status { min-height: 24px; margin-top: 15px; font-size: 14px; }
    #status.error { color: var(--error); }
    #status.success { color: var(--accent); font-weight: 650; }
    .model-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .secondary { min-height: 46px; padding: 0 14px; border: 1px solid var(--accent); border-radius: 6px; background: #fff; color: var(--accent); font: 650 14px/1 inherit; cursor: pointer; white-space: nowrap; }
    .secondary:hover { background: var(--paper); }
    select { width: 100%; min-height: 42px; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; }
    select[hidden] { display: none; }
    #models-status.error { color: var(--error); }
  </style>
</head>
<body>
  <main>
    <h1>My Image</h1>
    <p>填写两项即可开始生图。模型已默认设为 gpt-image-2.5，可按需修改。</p>
    <form id="setup-form">
      <label for="base-url">Base URL</label>
      <input id="base-url" name="baseUrl" type="url" required autofocus placeholder="https://example.com/v1" autocomplete="url" value="${escapeHtml(existing.baseUrl)}">

      <label for="api-key">API Key</label>
      <div class="key-row">
        <input id="api-key" name="apiKey" type="password" ${existing.hasApiKey ? 'placeholder="已保存，留空则沿用原 Key"' : "required"} autocomplete="new-password" spellcheck="false">
        <button class="icon-button" id="toggle-key" type="button" title="显示或隐藏 API Key" aria-label="显示或隐藏 API Key">◉</button>
      </div>

      <label for="model">模型</label>
      <div class="model-row">
        <input id="model" name="model" value="${escapeHtml(existing.model)}" spellcheck="false">
        <button class="secondary" id="fetch-models" type="button">获取模型</button>
      </div>
      <select id="model-list" hidden aria-label="上游模型列表"></select>
      <div class="hint" id="models-status">填好 Base URL 和 API Key 后，可点击「获取模型」从上游读取可用模型，同时验证连接。</div>
      <div class="hint">配置文件：${safePath}</div>

      <button type="submit">保存配置</button>
      <div id="status" role="status" aria-live="polite"></div>
    </form>
  </main>
  <script nonce="${nonce}">
    const token = ${JSON.stringify(token)};
    const form = document.querySelector('#setup-form');
    const keyInput = document.querySelector('#api-key');
    const toggle = document.querySelector('#toggle-key');
    const status = document.querySelector('#status');
    toggle.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });
    const modelInput = document.querySelector('#model');
    const modelList = document.querySelector('#model-list');
    const modelsStatus = document.querySelector('#models-status');
    const fetchButton = document.querySelector('#fetch-models');
    function addGroup(label, ids) {
      if (!ids.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const id of ids) group.append(new Option(id, id, false, id === modelInput.value));
      modelList.append(group);
    }
    modelList.addEventListener('change', () => { modelInput.value = modelList.value; });
    fetchButton.addEventListener('click', async () => {
      fetchButton.disabled = true;
      modelsStatus.className = 'hint';
      modelsStatus.textContent = '正在获取上游模型...';
      try {
        const response = await fetch('/models?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: form.baseUrl.value, apiKey: keyInput.value, model: modelInput.value }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '获取失败');
        if (result.baseUrl) form.baseUrl.value = result.baseUrl;
        if (result.model) modelInput.value = result.model;
        modelList.replaceChildren();
        addGroup('图像模型', result.image);
        addGroup('其他模型', result.other);
        modelList.hidden = result.count === 0;
        if (result.count && !modelList.value) modelList.selectedIndex = -1;
        modelsStatus.textContent = result.count
          ? '连接成功：共 ' + result.count + ' 个模型，其中疑似图像模型 ' + result.image.length + ' 个。从下拉框选择或直接输入。'
          : '连接成功，但上游没有返回模型列表，请手动填写模型名。';
      } catch (error) {
        modelList.hidden = true;
        modelsStatus.className = 'hint error';
        modelsStatus.textContent = error.message;
      } finally {
        fetchButton.disabled = false;
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      status.className = '';
      status.textContent = '正在验证连接并保存...';
      try {
        const response = await fetch('/save?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '保存失败');
        form.querySelectorAll('input, button').forEach((item) => item.disabled = true);
        if (result.baseUrl) form.baseUrl.value = result.baseUrl;
        if (result.model) modelInput.value = result.model;
        status.className = 'success';
        status.textContent = (result.verified ? '连接已验证，配置完成。' : '配置已保存（未能验证连接）。')
          + (result.warnings.length ? ' ' + result.warnings.join('；') + '。' : '')
          + ' 现在可以回到 Codex 继续生图。';
      } catch (error) {
        button.disabled = false;
        status.className = 'error';
        status.textContent = error.message;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// 表单里 API Key 留空时，只有 Base URL 与已保存的一致才沿用旧 Key，避免把 Key 发给新地址。
function resolveApiKey(values, existing) {
  const typed = String(values.apiKey || "").trim();
  if (typed) return typed;
  if (existing.apiKey && normalizeBaseUrl(values.baseUrl) === existing.baseUrl) return existing.apiKey;
  throw new Error(existing.apiKey ? "Base URL 已变更，请重新填写 API Key" : "API Key 不能为空");
}

function securityHeaders(nonce) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error("请求内容过大");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("配置数据格式无效");
  }
}

async function serveSetup(options) {
  const token = randomBytes(24).toString("hex");
  const nonce = randomBytes(18).toString("base64url");
  const configPath = getConfigPath();
  const status = await loadConfig();
  const existing = {
    baseUrl: status.config.baseUrl,
    apiKey: status.config.apiKey,
    hasApiKey: status.config.hasApiKey,
    model: status.config.model,
  };
  let finished = false;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const headers = securityHeaders(nonce);
    if (requestUrl.searchParams.get("token") !== token) {
      response.writeHead(403, { ...headers, "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "无效的配置链接" }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
      response.end(htmlPage(token, configPath, nonce, existing));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/models") {
      try {
        const body = await readJsonBody(request);
        const result = await probeConnection({
          baseUrl: normalizeBaseUrl(body.baseUrl),
          apiKey: resolveApiKey(body, existing),
          model: String(body.model || "").trim() || "gpt-image-2.5",
        });
        if (!result.verified) throw new Error(`获取失败：${result.error}`);
        const { image, other } = sortModelsForImages(result.models);
        response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ count: result.models.length, image, other, baseUrl: result.baseUrl, model: result.model }));
      } catch (error) {
        const message = error.status === 401 || error.status === 403
          ? "API Key 无效或无权限"
          : error.status ? `上游返回错误 (${error.status})：${error.message}` : error.message;
        response.writeHead(400, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/save") {
      try {
        const body = await readJsonBody(request);
        const result = await save({
          defaultSize: status.config.defaultSize,
          mode: status.config.mode,
          timeoutMs: status.config.timeoutMs,
          ...body,
          apiKey: resolveApiKey(body, existing),
        }, { skipVerify: options.skipVerify });
        response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          ok: true,
          verified: result.verification.verified,
          baseUrl: result.baseUrl,
          model: result.model,
          warnings: result.warnings,
        }));
        printSaved(result);
        finished = true;
        setTimeout(() => server.close(), 250);
      } catch (error) {
        response.writeHead(400, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    response.writeHead(404, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/?token=${token}`;
  console.log(`MY_IMAGE_SETUP_URL=${url}`);
  console.log(`MY_IMAGE_CONFIG_PATH=${configPath}`);
  const browserOpened = options.noOpen ? false : openBrowser(url);
  console.log(`MY_IMAGE_BROWSER_OPENED=${browserOpened ? "1" : "0"}`);

  const timer = setTimeout(() => server.close(), options.timeoutMs);
  await new Promise((resolveClose, rejectClose) => {
    server.once("close", resolveClose);
    server.once("error", rejectClose);
  });
  clearTimeout(timer);
  if (!finished) throw new Error("配置等待超时，请重新调用 my-image");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.stdinJson) {
    const raw = await readStdin();
    let values;
    try {
      values = JSON.parse(raw);
    } catch {
      throw new Error("标准输入必须是 JSON 配置");
    }
    const result = await save(values, { skipVerify: options.skipVerify });
    console.log(JSON.stringify({
      ok: true,
      configPath: result.configPath,
      verified: result.verification.verified,
      baseUrl: result.baseUrl,
      model: result.model,
      warnings: result.warnings,
    }, null, 2));
    return;
  }
  await serveSetup(options);
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
