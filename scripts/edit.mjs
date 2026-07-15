#!/usr/bin/env node

import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectImageInfo, inferSize, sanitize, saveImageItem, timestamp } from "./generate.mjs";
import { editEndpoint, loadConfig } from "./verify-config.mjs";

const MAX_IMAGES = 16;
const MAX_OUTPUTS = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

function parseArgs(argv) {
  const options = { images: [], count: 1, size: "auto", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--image") options.images.push(argv[++index]);
    else if (arg === "--mask") options.mask = argv[++index];
    else if (arg === "--prompt") options.prompt = argv[++index];
    else if (arg === "--prompt-file") options.promptFile = argv[++index];
    else if (arg === "--size") options.size = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--count") options.count = Number(argv[++index]);
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--quality") options.quality = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`未知参数: ${arg}`);
  }

  if (!options.images.length) throw new Error("至少需要一个 --image 输入文件");
  if (options.images.length > MAX_IMAGES) throw new Error(`最多支持 ${MAX_IMAGES} 张输入图片`);
  if (options.prompt && options.promptFile) throw new Error("--prompt 与 --prompt-file 只能使用一个");
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > MAX_OUTPUTS) {
    throw new Error(`--count 必须是 1-${MAX_OUTPUTS} 的整数`);
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000)) {
    throw new Error("--timeout-ms 必须是不小于 1000 的整数");
  }
  if (options.quality && !["low", "medium", "high", "auto"].includes(options.quality)) {
    throw new Error("--quality 必须是 low、medium、high 或 auto");
  }
  return options;
}

async function readPrompt(options) {
  const prompt = options.promptFile
    ? await readFile(resolve(options.promptFile), "utf8")
    : options.prompt;
  if (!prompt || !prompt.trim()) throw new Error("图片编辑提示词不能为空");
  return prompt.trim();
}

function mimeType(extension) {
  if (extension === "png") return "image/png";
  if (extension === "jpg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  throw new Error(`不支持的图片格式: ${extension}`);
}

function pngHasTransparency(buffer) {
  if (buffer.length < 26) return false;
  const colorType = buffer[25];
  if (colorType === 4 || colorType === 6) return true;

  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") return true;
    offset += length + 12;
  }
  return false;
}

async function loadInputImage(filePath, label) {
  const path = resolve(filePath);
  const fileStat = await stat(path).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label}不存在: ${path}`);
    throw error;
  });
  if (!fileStat.isFile()) throw new Error(`${label}不是文件: ${path}`);
  if (fileStat.size > MAX_FILE_BYTES) throw new Error(`${label}超过 50MB: ${path}`);

  const buffer = await readFile(path);
  const info = detectImageInfo(buffer);
  return { path, name: basename(path), buffer, info, type: mimeType(info.extension) };
}

function selectEditSize(option, firstImage, model) {
  if (option && option !== "auto") return inferSize(option, model);
  const { width, height } = firstImage.info;
  if (!width || !height) return { size: "auto", reason: "无法读取输入比例，交由接口自动选择" };
  const ratio = width / height;
  if (ratio >= 1.2) return { size: "1536x1024", reason: "保持输入图片的横向构图" };
  if (ratio <= 0.83) return { size: "1024x1536", reason: "保持输入图片的竖向构图" };
  return { size: "1024x1024", reason: "保持输入图片的近方形构图" };
}

function appendImage(form, field, image) {
  form.append(field, new Blob([image.buffer], { type: image.type }), image.name);
}

function buildForm({ model, prompt, size, quality, count, images, mask }) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("n", String(count));
  if (quality && quality !== "auto") form.append("quality", quality);

  const imageField = images.length === 1 ? "image" : "image[]";
  for (const image of images) appendImage(form, imageField, image);
  if (mask) appendImage(form, "mask", mask);
  return form;
}

async function callEditApi(context) {
  const response = await fetch(context.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${context.apiKey}` },
    body: buildForm(context),
    signal: AbortSignal.timeout(context.timeoutMs),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  if (!response.ok) {
    const error = new Error(`图片编辑接口返回 HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = await readPrompt(options);
  const status = await loadConfig();
  if (!status.ok) {
    const error = new Error("my-image 尚未配置，请先运行 configure.mjs");
    error.code = "CONFIG_REQUIRED";
    throw error;
  }

  const images = await Promise.all(options.images.map((path, index) => loadInputImage(path, `输入图片 ${index + 1}`)));
  const mask = options.mask ? await loadInputImage(options.mask, "蒙版") : null;
  const totalBytes = images.reduce((sum, image) => sum + image.buffer.length, 0) + (mask?.buffer.length || 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("输入图片和蒙版总大小不能超过 200MB");
  if (mask) {
    if (mask.info.extension !== "png") throw new Error("蒙版必须是 PNG 文件");
    if (!pngHasTransparency(mask.buffer)) throw new Error("蒙版 PNG 必须包含 Alpha 或透明信息");
    const first = images[0].info;
    if (first.width && first.height && mask.info.width && mask.info.height
      && (first.width !== mask.info.width || first.height !== mask.info.height)) {
      throw new Error("蒙版尺寸必须与第一张输入图片一致");
    }
  }

  const model = options.model || status.config.model || "gpt-image-2";
  const sizeSelection = selectEditSize(options.size, images[0], model);
  const timeoutMs = options.timeoutMs || status.config.timeoutMs;
  const outputDir = resolve(options.outputDir || "outputs/my-image");
  const endpoint = editEndpoint(status.config.baseUrl);
  const preview = {
    endpoint,
    model,
    prompt,
    size: sizeSelection.size,
    sizeReason: sizeSelection.reason,
    quality: options.quality || null,
    count: options.count,
    images: images.map((image) => ({ path: image.path, size: image.info.width && image.info.height ? `${image.info.width}x${image.info.height}` : null })),
    mask: mask ? mask.path : null,
    outputDir,
  };

  if (options.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...preview }, null, 2));
    return;
  }

  await mkdir(outputDir, { recursive: true });
  try {
    const body = await callEditApi({
      endpoint,
      apiKey: status.config.apiKey,
      model,
      prompt,
      size: sizeSelection.size,
      quality: options.quality,
      count: options.count,
      images,
      mask,
      timeoutMs,
    });
    const items = Array.isArray(body.data) ? body.data.slice(0, options.count) : [];
    if (!items.length) throw new Error("响应中没有可保存的编辑图片");

    const runId = `${timestamp()}-${process.pid}`;
    const results = [];
    for (let index = 0; index < items.length; index += 1) {
      const saved = await saveImageItem({
        item: items[index],
        endpoint,
        timeoutMs,
        outputDir,
        filenameBase: `edit-${runId}-${String(index + 1).padStart(3, "0")}`,
      });
      results.push({
        ok: true,
        requestNumber: index + 1,
        path: saved.path,
        bytes: saved.bytes,
        requestedSize: sizeSelection.size,
        actualSize: saved.actualSize,
        size: saved.actualSize || sizeSelection.size,
      });
    }

    const summary = {
      ok: results.length === options.count,
      operation: "edit",
      model,
      requestedSize: sizeSelection.size,
      sizeReason: sizeSelection.reason,
      count: options.count,
      succeeded: results.length,
      failed: options.count - results.length,
      outputDir,
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    const statusCode = Number(error.status || 0);
    console.log(JSON.stringify({
      ok: false,
      operation: "edit",
      status: statusCode,
      code: statusCode === 401 || statusCode === 403 ? "AUTH_FAILED" : statusCode === 429 ? "RATE_LIMITED" : "EDIT_FAILED",
      error: sanitize(error.body || error.message, status.config.apiKey),
    }, null, 2));
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || "FATAL", error: error.message }, null, 2));
    process.exitCode = error.code === "CONFIG_REQUIRED" ? 2 : 1;
  });
}
