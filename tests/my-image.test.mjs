#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectImageInfo, inferSize } from "../scripts/generate.mjs";
import { editEndpoint, loadConfig, modelsEndpoint, normalizeBaseUrl, probeConnection, saveConfig } from "../scripts/verify-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configureScript = join(repoRoot, "scripts", "configure.mjs");
const editScript = join(repoRoot, "scripts", "edit.mjs");
const verifyScript = join(repoRoot, "scripts", "verify-config.mjs");
const generateScript = join(repoRoot, "scripts", "generate.mjs");
const modelsScript = join(repoRoot, "scripts", "models.mjs");
const fakeKey = "test-api-key-never-print-this-value";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0YQAAAAASUVORK5CYII=",
  "base64",
);

function sampleJpeg() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x00, 0x10,
    0x00, 0x20,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

function sampleWebp() {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUIntLE(319, 24, 3);
  buffer.writeUIntLE(239, 27, 3);
  return buffer;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(options.stdin);
  const code = await new Promise((resolveCode, rejectCode) => {
    child.once("error", rejectCode);
    child.once("close", resolveCode);
  });
  return { code, stdout, stderr };
}

async function configureViaStdin(configPath, baseUrl) {
  const result = await run("node", [configureScript, "--stdin-json"], {
    env: { MY_IMAGE_GEN_ENV_FILE: configPath },
    stdin: JSON.stringify({ baseUrl, apiKey: fakeKey, model: "gpt-image-2.5" }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert(!result.stdout.includes(fakeKey), "configure output leaked API key");
}

async function testConfigFile(root) {
  const configPath = join(root, "stdin-config", ".env");
  await configureViaStdin(configPath, "https://example.test/v1");
  const content = await readFile(configPath, "utf8");
  assert(content.includes("OPENAI_BASE_URL"));
  assert(content.includes("gpt-image-2.5"));
  if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  const verified = await run("node", [verifyScript, "--json"], {
    env: { MY_IMAGE_GEN_ENV_FILE: configPath },
  });
  assert.equal(verified.code, 0, verified.stderr);
  assert(!verified.stdout.includes(fakeKey), "verify output leaked API key");
  const status = JSON.parse(verified.stdout);
  assert.equal(status.config.model, "gpt-image-2.5");
  assert.equal(status.config.mode, "sync");
  assert.equal(status.config.endpoint, "https://example.test/v1/images/generations");
  assert.equal(editEndpoint(status.config.baseUrl), "https://example.test/v1/images/edits");
  assert.throws(() => normalizeBaseUrl("https://example.test/v1?token=bad"));

  // 配置文件缺少模式或模式无效时，也不能意外发出异步请求。
  await writeFile(configPath, content.replace(/^IMAGE_MODE=.*\n/m, ""));
  const legacy = await loadConfig({ configPath, env: {} });
  assert.equal(legacy.config.mode, "sync");
  const invalid = await loadConfig({ configPath, env: { IMAGE_MODE: "invalid" } });
  assert.equal(invalid.config.mode, "sync");
  assert(invalid.warnings.length > 0);
  await saveConfig({ baseUrl: "https://example.test/v1", apiKey: fakeKey }, { configPath });
  assert.equal((await loadConfig({ configPath, env: {} })).config.mode, "sync");
}

async function testBrowserSetup(root) {
  const configPath = join(root, "browser-config", ".env");
  const child = spawn("node", [configureScript, "--no-open", "--timeout-ms", "10000"], {
    cwd: repoRoot,
    env: { ...process.env, MY_IMAGE_GEN_ENV_FILE: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const setupUrl = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error("setup URL timeout")), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/MY_IMAGE_SETUP_URL=(http:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]);
    });
    child.once("error", rejectUrl);
  });

  const page = await fetch(setupUrl);
  assert.equal(page.status, 200);
  assert((await page.text()).includes("gpt-image-2.5"));
  const parsed = new URL(setupUrl);
  const saved = await fetch(`${parsed.origin}/save?token=${encodeURIComponent(parsed.searchParams.get("token"))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://browser.example/v1", apiKey: fakeKey, model: "gpt-image-2.5" }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const code = await new Promise((resolveCode) => child.once("close", resolveCode));
  assert.equal(code, 0, stderr);
  assert(!stdout.includes(fakeKey), "browser setup output leaked API key");
}

async function startSetupServer(configPath) {
  const child = spawn("node", [configureScript, "--no-open", "--timeout-ms", "10000"], {
    cwd: repoRoot,
    env: { ...process.env, MY_IMAGE_GEN_ENV_FILE: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const setupUrl = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error("setup URL timeout")), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/MY_IMAGE_SETUP_URL=(http:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]);
    });
    child.once("error", rejectUrl);
  });
  const parsed = new URL(setupUrl);
  const token = encodeURIComponent(parsed.searchParams.get("token"));
  const post = (path, body) => fetch(`${parsed.origin}${path}?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { child, setupUrl, post, output: () => stdout };
}

async function testSetupModelPicker(root, api) {
  const configPath = join(root, "picker-config", ".env");
  await configureViaStdin(configPath, api.baseUrl);
  const setup = await startSetupServer(configPath);
  try {
    const page = await (await fetch(setup.setupUrl)).text();
    assert(page.includes("获取模型"));
    assert(page.includes(api.baseUrl), "setup page should prefill saved Base URL");
    assert(!page.includes(fakeKey), "setup page leaked API key");

    const listed = await setup.post("/models", { baseUrl: api.baseUrl, apiKey: "" });
    assert.equal(listed.status, 200, await listed.clone().text());
    const models = await listed.json();
    assert.equal(models.count, 2);
    assert.deepEqual(models.image, ["gpt-image-2", "gpt-image-2.5"]);

    const otherHost = await setup.post("/models", { baseUrl: "https://other.example/v1", apiKey: "" });
    assert.equal(otherHost.status, 400);

    const saved = await setup.post("/save", { baseUrl: api.baseUrl, apiKey: "", model: "gpt-image-2" });
    assert.equal(saved.status, 200, await saved.text());
    await new Promise((resolveClose) => setup.child.once("close", resolveClose));
    assert(!setup.output().includes(fakeKey), "setup output leaked API key");
    const content = await readFile(configPath, "utf8");
    assert(content.includes(fakeKey), "saved key should be reused when left blank");
    assert(content.includes('IMAGE_MODEL="gpt-image-2"'));
  } finally {
    setup.child.kill();
  }
}

async function testConnectionProbe(root) {
  // 网关根路径返回网页，只有 /v1/models 是真实接口，且没有默认模型。
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${fakeKey}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    if (request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "chat-model" }, { id: "flux-pro" }] }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html>console</html>");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fixed = await probeConnection({ baseUrl: base, apiKey: fakeKey, model: "gpt-image-2.5" });
    assert.equal(fixed.verified, true);
    assert.equal(fixed.baseUrl, `${base}/v1`);
    assert.equal(fixed.model, "flux-pro");
    assert.equal(fixed.changed, true);

    const custom = await probeConnection({ baseUrl: base, apiKey: fakeKey, model: "my-custom" });
    assert.equal(custom.model, "my-custom");
    assert.equal(custom.unlisted, true);

    await assert.rejects(
      probeConnection({ baseUrl: base, apiKey: "wrong", model: "gpt-image-2.5" }),
      (error) => error.code === "AUTH_FAILED",
    );

    const configPath = join(root, "probe-config", ".env");
    const saved = await run("node", [configureScript, "--stdin-json"], {
      env: { MY_IMAGE_GEN_ENV_FILE: configPath },
      stdin: JSON.stringify({ baseUrl: base, apiKey: fakeKey }),
    });
    assert.equal(saved.code, 0, saved.stderr);
    assert(!saved.stdout.includes(fakeKey), "configure output leaked API key");
    const summary = JSON.parse(saved.stdout);
    assert.equal(summary.verified, true);
    assert.equal(summary.baseUrl, `${base}/v1`);
    assert.equal(summary.model, "flux-pro");

    const rejectedPath = join(root, "probe-rejected", ".env");
    const rejected = await run("node", [configureScript, "--stdin-json"], {
      env: { MY_IMAGE_GEN_ENV_FILE: rejectedPath },
      stdin: JSON.stringify({ baseUrl: base, apiKey: "wrong" }),
    });
    assert.equal(rejected.code, 1);
    await assert.rejects(stat(rejectedPath), "auth failure must not write config");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function startMockApi() {
  const requests = { generation: [], edit: [] };
  const tasks = new Map();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [
        { id: "gpt-image-2", object: "model" },
        { id: "gpt-image-2.5", object: "model" },
      ] }));
      return;
    }
    if (request.method === "GET" && request.url === "/image.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(png);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/images/generations/async") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.generation.push({ ...body, asyncSubmit: true });

      if (body.prompt.includes("auth-mode")) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `bad key ${fakeKey}` } }));
        return;
      }
      if (body.prompt.includes("fallback-mode") && body.size !== "1536x1024") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unsupported image size" } }));
        return;
      }
      tasks.set("task_gen", body);
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ task_id: "task_gen", status: "pending" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/images/edits/async") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("latin1");
      requests.edit.push({ contentType: request.headers["content-type"], raw, asyncSubmit: true });
      if (raw.includes("auth-edit-mode")) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `bad key ${fakeKey}` } }));
        return;
      }
      tasks.set("task_edit", raw);
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ task_id: "task_edit", status: "pending" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/images/tasks/task_gen") {
      const body = tasks.get("task_gen") || {};
      const address = server.address();
      const item = String(body.prompt || "").includes("url-mode")
        ? { url: `http://127.0.0.1:${address.port}/image.png` }
        : { b64_json: png.toString("base64") };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "task_gen", status: "completed", result: { data: [item] } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/images/tasks/task_edit") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "task_edit", status: "completed", result: { data: [{ b64_json: png.toString("base64") }] } }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/images/edits") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("latin1");
      requests.edit.push({ contentType: request.headers["content-type"], raw });

      if (raw.includes("auth-edit-mode")) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `bad key ${fakeKey}` } }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/images/generations") {
      response.writeHead(404).end();
      return;
    }

    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.generation.push(body);

    if (body.prompt.includes("auth-mode")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `bad key ${fakeKey}` } }));
      return;
    }
    if (body.prompt.includes("fallback-mode") && body.size !== "1536x1024") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unsupported image size" } }));
      return;
    }
    if (body.prompt.includes("url-mode")) {
      const address = server.address();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${address.port}/image.png` }] }));
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function testGeneration(root) {
  const api = await startMockApi();
  try {
    const configPath = join(root, "api-config", ".env");
    const outputDir = join(root, "outputs");
    await configureViaStdin(configPath, api.baseUrl);
    await testSetupModelPicker(root, api);

    assert.equal(inferSize("网站首屏横幅，现代产品展示").size, "2048x1152");
    assert.equal(inferSize("手机壁纸，竖屏 9:16").size, "1152x2048");
    assert.equal(inferSize("现代办公建筑室内空间").size, "1536x1024");
    assert.equal(inferSize("生成一张 1920x1080 横图").size, "1920x1088");
    assert.deepEqual(detectImageInfo(png), { extension: "png", width: 1, height: 1 });
    assert.deepEqual(detectImageInfo(sampleJpeg()), { extension: "jpg", width: 32, height: 16 });
    assert.deepEqual(detectImageInfo(sampleWebp()), { extension: "webp", width: 320, height: 240 });

    const base64Result = await run(
      "node",
      [generateScript, "--prompt", "base64-mode 方形头像", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(base64Result.code, 0, base64Result.stderr);
    const base64Summary = JSON.parse(base64Result.stdout);
    assert.equal(base64Summary.transport, "sync");
    assert.equal(base64Summary.results[0].actualSize, "1x1");
    assert.equal(base64Summary.results[0].requestedSize, "1024x1024");

    const urlResult = await run(
      "node",
      [generateScript, "--prompt", "url-mode 横幅", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(urlResult.code, 0, urlResult.stderr);

    const fallbackResult = await run(
      "node",
      [generateScript, "--prompt", "fallback-mode", "--size", "2048x1152", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(fallbackResult.code, 0, fallbackResult.stderr);
    const fallbackSummary = JSON.parse(fallbackResult.stdout);
    assert.equal(fallbackSummary.results[0].usedFallback, true);
    assert.equal(fallbackSummary.results[0].requestedSize, "1536x1024");

    const batchResult = await run(
      "node",
      [generateScript, "--prompt", "batch-mode 方形产品图", "--count", "3", "--concurrency", "2", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(batchResult.code, 0, batchResult.stderr);
    const batchSummary = JSON.parse(batchResult.stdout);
    assert.equal(batchSummary.succeeded, 3);
    assert.equal(new Set(batchSummary.results.map((item) => item.path)).size, 3);

    const authResult = await run(
      "node",
      [generateScript, "--prompt", "auth-mode", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(authResult.code, 1);
    assert(!authResult.stdout.includes(fakeKey), "generation output leaked API key");
    assert.equal(JSON.parse(authResult.stdout).results[0].code, "AUTH_FAILED");
    assert(api.requests.generation.every((item) => item.model === "gpt-image-2.5"));
    assert(api.requests.generation.every((item) => !item.asyncSubmit), "default generation must not probe async endpoints");

    const asyncResult = await run(
      "node",
      [generateScript, "--prompt", "explicit async 方形头像", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath, IMAGE_MODE: "async" } },
    );
    assert.equal(asyncResult.code, 0, asyncResult.stderr);
    assert.equal(JSON.parse(asyncResult.stdout).transport, "async");
    assert.equal(api.requests.generation.at(-1).asyncSubmit, true);

    assert.equal(modelsEndpoint(api.baseUrl), `${api.baseUrl}/models`);
    assert.equal(modelsEndpoint(`${api.baseUrl}/images/generations`), `${api.baseUrl}/models`);

    const modelsResult = await run("node", [modelsScript, "--json"], {
      env: { MY_IMAGE_GEN_ENV_FILE: configPath },
    });
    assert.equal(modelsResult.code, 0, modelsResult.stderr);
    assert(!modelsResult.stdout.includes(fakeKey), "models output leaked API key");
    const modelsSummary = JSON.parse(modelsResult.stdout);
    assert.equal(modelsSummary.currentModel, "gpt-image-2.5");
    assert(modelsSummary.models.includes("gpt-image-2.5"));

    const setResult = await run("node", [modelsScript, "--set", "gpt-image-2"], {
      env: { MY_IMAGE_GEN_ENV_FILE: configPath },
    });
    assert.equal(setResult.code, 0, setResult.stderr);
    const verifiedAfterSet = await run("node", [verifyScript, "--json"], {
      env: { MY_IMAGE_GEN_ENV_FILE: configPath },
    });
    assert.equal(JSON.parse(verifiedAfterSet.stdout).config.model, "gpt-image-2");

    const missingModelResult = await run("node", [modelsScript, "--set", "no-such-model"], {
      env: { MY_IMAGE_GEN_ENV_FILE: configPath },
    });
    assert.equal(missingModelResult.code, 1);
    assert.equal(JSON.parse(missingModelResult.stdout).code, "MODEL_NOT_FOUND");

    await run("node", [modelsScript, "--set", "gpt-image-2.5"], {
      env: { MY_IMAGE_GEN_ENV_FILE: configPath },
    });

    const inputPath = join(root, "edit-input.png");
    const referencePath = join(root, "edit-reference.png");
    const maskPath = join(root, "edit-mask.png");
    const opaqueMaskPath = join(root, "edit-opaque-mask.png");
    const opaquePng = Buffer.from(png);
    opaquePng[25] = 2;
    await Promise.all([
      writeFile(inputPath, png),
      writeFile(referencePath, png),
      writeFile(maskPath, png),
      writeFile(opaqueMaskPath, opaquePng),
    ]);

    const opaqueMaskResult = await run(
      "node",
      [editScript, "--image", inputPath, "--mask", opaqueMaskPath, "--prompt", "edit-mode"],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(opaqueMaskResult.code, 1);
    assert(opaqueMaskResult.stderr.includes("Alpha"));

    const editResult = await run(
      "node",
      [
        editScript,
        "--image", inputPath,
        "--image", referencePath,
        "--mask", maskPath,
        "--prompt", "edit-mode keep the subject unchanged",
        "--output-dir", outputDir,
      ],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(editResult.code, 0, `${editResult.stderr}\n${editResult.stdout}`);
    const editSummary = JSON.parse(editResult.stdout);
    assert.equal(editSummary.operation, "edit");
    assert.equal(editSummary.transport, "sync");
    assert.equal(editSummary.results[0].actualSize, "1x1");
    const editRequest = api.requests.edit.at(-1);
    assert(editRequest.contentType.startsWith("multipart/form-data; boundary="));
    assert(editRequest.raw.includes('name="image[]"'));
    assert(editRequest.raw.includes('name="mask"'));
    assert(editRequest.raw.includes("edit-mode keep the subject unchanged"));

    const editAuthResult = await run(
      "node",
      [editScript, "--image", inputPath, "--prompt", "auth-edit-mode", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(editAuthResult.code, 1);
    assert(!editAuthResult.stdout.includes(fakeKey), "edit output leaked API key");
    assert.equal(JSON.parse(editAuthResult.stdout).code, "AUTH_FAILED");
    assert(api.requests.edit.every((item) => !item.asyncSubmit), "default edits must not probe async endpoints");

    const asyncEditResult = await run(
      "node",
      [editScript, "--image", inputPath, "--prompt", "explicit async edit", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath, IMAGE_MODE: "async" } },
    );
    assert.equal(asyncEditResult.code, 0, asyncEditResult.stderr);
    assert.equal(JSON.parse(asyncEditResult.stdout).transport, "async");
    assert.equal(api.requests.edit.at(-1).asyncSubmit, true);
  } finally {
    await api.close();
  }
}

async function startSyncOnlyApi() {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    if (request.method === "POST" && request.url === "/v1/images/generations/async") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/images/generations") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (body.prompt.includes("async-forced")) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function testSyncFallback(root) {
  const api = await startSyncOnlyApi();
  try {
    const configPath = join(root, "sync-fallback-config", ".env");
    const outputDir = join(root, "sync-outputs");
    await configureViaStdin(configPath, api.baseUrl);

    api.requests.length = 0;
    const defaultResult = await run(
      "node",
      [generateScript, "--prompt", "default 方形头像", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath } },
    );
    assert.equal(defaultResult.code, 0, defaultResult.stderr);
    assert.equal(JSON.parse(defaultResult.stdout).transport, "sync");
    assert.deepEqual(api.requests, ["/v1/images/generations"]);

    // auto 模式：异步 404 后应自动降级同步并成功出图
    api.requests.length = 0;
    const autoResult = await run(
      "node",
      [generateScript, "--prompt", "sync-only 方形头像", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath, IMAGE_MODE: "auto" } },
    );
    assert.equal(autoResult.code, 0, autoResult.stderr);
    const autoSummary = JSON.parse(autoResult.stdout);
    assert.equal(autoSummary.transport, "sync");
    assert.equal(autoSummary.succeeded, 1);
    assert.deepEqual(api.requests, ["/v1/images/generations/async", "/v1/images/generations"]);

    // 显式 async 模式：不支持异步时应直接失败而不是降级
    const asyncOnlyResult = await run(
      "node",
      [generateScript, "--prompt", "async-forced 方形头像", "--output-dir", outputDir],
      { env: { MY_IMAGE_GEN_ENV_FILE: configPath, IMAGE_MODE: "async" } },
    );
    assert.equal(asyncOnlyResult.code, 1);
    assert.equal(JSON.parse(asyncOnlyResult.stdout).results[0].status, 404);
  } finally {
    await api.close();
  }
}

const root = await mkdtemp(join(tmpdir(), "my-image-test-"));
try {
  await testConfigFile(root);
  await testBrowserSetup(root);
  await testConnectionProbe(root);
  await testGeneration(root);
  await testSyncFallback(root);
  console.log("my-image tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
