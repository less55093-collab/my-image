#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectImageInfo, inferSize } from "../scripts/generate.mjs";
import { editEndpoint, normalizeBaseUrl } from "../scripts/verify-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configureScript = join(repoRoot, "scripts", "configure.mjs");
const editScript = join(repoRoot, "scripts", "edit.mjs");
const verifyScript = join(repoRoot, "scripts", "verify-config.mjs");
const generateScript = join(repoRoot, "scripts", "generate.mjs");
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
    stdin: JSON.stringify({ baseUrl, apiKey: fakeKey, model: "gpt-image-2" }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert(!result.stdout.includes(fakeKey), "configure output leaked API key");
}

async function testConfigFile(root) {
  const configPath = join(root, "stdin-config", ".env");
  await configureViaStdin(configPath, "https://example.test/v1");
  const content = await readFile(configPath, "utf8");
  assert(content.includes("OPENAI_BASE_URL"));
  assert(content.includes("gpt-image-2"));
  if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  const verified = await run("node", [verifyScript, "--json"], {
    env: { MY_IMAGE_GEN_ENV_FILE: configPath },
  });
  assert.equal(verified.code, 0, verified.stderr);
  assert(!verified.stdout.includes(fakeKey), "verify output leaked API key");
  const status = JSON.parse(verified.stdout);
  assert.equal(status.config.model, "gpt-image-2");
  assert.equal(status.config.endpoint, "https://example.test/v1/images/generations");
  assert.equal(editEndpoint(status.config.baseUrl), "https://example.test/v1/images/edits");
  assert.throws(() => normalizeBaseUrl("https://example.test/v1?token=bad"));
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
  assert((await page.text()).includes("gpt-image-2"));
  const parsed = new URL(setupUrl);
  const saved = await fetch(`${parsed.origin}/save?token=${encodeURIComponent(parsed.searchParams.get("token"))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://browser.example/v1", apiKey: fakeKey, model: "gpt-image-2" }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const code = await new Promise((resolveCode) => child.once("close", resolveCode));
  assert.equal(code, 0, stderr);
  assert(!stdout.includes(fakeKey), "browser setup output leaked API key");
}

async function startMockApi() {
  const requests = { generation: [], edit: [] };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/image.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(png);
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
    assert(api.requests.generation.every((item) => item.model === "gpt-image-2"));

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
  } finally {
    await api.close();
  }
}

const root = await mkdtemp(join(tmpdir(), "my-image-test-"));
try {
  await testConfigFile(root);
  await testBrowserSetup(root);
  await testGeneration(root);
  console.log("my-image tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
