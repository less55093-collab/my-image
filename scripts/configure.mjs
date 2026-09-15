#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getConfigPath, saveConfig } from "./verify-config.mjs";

function parseArgs(argv) {
  const options = { noOpen: false, stdinJson: false, timeoutMs: 600_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--stdin-json") options.stdinJson = true;
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

async function save(values) {
  const result = await saveConfig({
    baseUrl: values.baseUrl ?? values.OPENAI_BASE_URL,
    apiKey: values.apiKey ?? values.OPENAI_API_KEY,
    model: values.model ?? values.IMAGE_MODEL ?? "gpt-image-2.5",
    defaultSize: values.defaultSize ?? values.IMAGE_SIZE ?? "auto",
    timeoutMs: values.timeoutMs ?? values.TIMEOUT_MS ?? 300_000,
  });
  return { ...result, warnings: applyWindowsAcl(result.configPath) };
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

function htmlPage(token, configPath, nonce) {
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
  </style>
</head>
<body>
  <main>
    <h1>My Image</h1>
    <p>填写两项即可开始生图。模型已默认设为 gpt-image-2.5，可按需修改。</p>
    <form id="setup-form">
      <label for="base-url">Base URL</label>
      <input id="base-url" name="baseUrl" type="url" required autofocus placeholder="https://example.com/v1" autocomplete="url">

      <label for="api-key">API Key</label>
      <div class="key-row">
        <input id="api-key" name="apiKey" type="password" required autocomplete="new-password" spellcheck="false">
        <button class="icon-button" id="toggle-key" type="button" title="显示或隐藏 API Key" aria-label="显示或隐藏 API Key">◉</button>
      </div>

      <label for="model">模型</label>
      <input id="model" name="model" value="gpt-image-2.5" spellcheck="false">
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
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      status.className = '';
      status.textContent = '正在保存...';
      try {
        const response = await fetch('/save?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '保存失败');
        form.querySelectorAll('input, button').forEach((item) => item.disabled = true);
        status.className = 'success';
        status.textContent = '配置完成。现在可以回到 Codex 继续生图。';
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
      response.end(htmlPage(token, configPath, nonce));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/save") {
      try {
        const result = await save(await readJsonBody(request));
        response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, warnings: result.warnings }));
        console.log(`MY_IMAGE_CONFIG_SAVED=${result.configPath}`);
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
    const result = await save(values);
    console.log(JSON.stringify({ ok: true, configPath: result.configPath, warnings: result.warnings }, null, 2));
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
