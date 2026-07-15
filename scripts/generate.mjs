#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./verify-config.mjs";

const MAX_COUNT = 10;
const MAX_CONCURRENCY = 4;

function parseArgs(argv) {
  const options = { count: 1, concurrency: 2, size: "auto", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt") options.prompt = argv[++index];
    else if (arg === "--prompt-file") options.promptFile = argv[++index];
    else if (arg === "--size") options.size = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--count") options.count = Number(argv[++index]);
    else if (arg === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--quality") options.quality = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`未知参数: ${arg}`);
  }

  if (options.prompt && options.promptFile) throw new Error("--prompt 与 --prompt-file 只能使用一个");
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > MAX_COUNT) {
    throw new Error(`--count 必须是 1-${MAX_COUNT} 的整数`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency 必须是 1-${MAX_CONCURRENCY} 的整数`);
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
  if (!prompt || !prompt.trim()) throw new Error("生图提示词不能为空");
  return prompt.trim();
}

function nearest16(value) {
  return Math.max(16, Math.round(value / 16) * 16);
}

function validateGptImage2Size(width, height) {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  if (longEdge > 3840) throw new Error("图片最长边不能超过 3840px");
  if (longEdge / shortEdge > 3) throw new Error("图片长宽比不能超过 3:1");
  if (pixels < 655_360 || pixels > 8_294_400) throw new Error("图片总像素超出 gpt-image-2 支持范围");
}

function normalizeExplicitSize(value, model) {
  const match = String(value).trim().match(/^(\d{3,4})\s*[x×*]\s*(\d{3,4})$/i);
  if (!match) throw new Error("尺寸必须使用 WIDTHxHEIGHT 格式，例如 1536x1024");
  let width = Number(match[1]);
  let height = Number(match[2]);
  const original = `${width}x${height}`;

  if (model === "gpt-image-2") {
    width = nearest16(width);
    height = nearest16(height);
    validateGptImage2Size(width, height);
  }

  return {
    size: `${width}x${height}`,
    reason: original === `${width}x${height}` ? "用户指定尺寸" : `用户尺寸已对齐为 ${width}x${height}`,
  };
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

export function inferSize(prompt, model = "gpt-image-2") {
  const text = prompt.toLowerCase();
  const explicit = text.match(/\b(\d{3,4})\s*[x×*]\s*(\d{3,4})\b/i);
  if (explicit) return normalizeExplicitSize(`${explicit[1]}x${explicit[2]}`, model);

  const is4k = includesAny(text, ["4k", "8k", "超高清", "大屏"]);
  const isHigh = is4k || includesAny(text, ["高分辨率", "高清", "最终稿", "成品", "印刷", "high resolution"]);
  const isDraft = includesAny(text, ["草图", "快速预览", "预览图", "draft", "thumbnail"]);
  const isMobile = includesAny(text, ["手机壁纸", "手机屏幕", "短视频", "竖屏视频", "story", "reel", "9:16"]);
  const isVertical = isMobile || includesAny(text, ["竖版", "竖屏", "海报", "书封", "书籍封面", "封面", "portrait", "poster"]);
  const isWide = includesAny(text, ["网站首屏", "网页首屏", "横幅", "横版", "横屏", "全景", "桌面壁纸", "banner", "hero", "16:9", "landscape", "cinematic"]);
  const isSquare = includesAny(text, ["头像", "图标", "方形", "正方形", "电商主图", "商品主图", "avatar", "icon", "1:1"]);
  const ratio = text.match(/\b(16|9|4|3|2|1)\s*[:：]\s*(16|9|4|3|2|1)\b/);

  if (ratio) {
    const key = `${ratio[1]}:${ratio[2]}`;
    const ratioSizes = {
      "16:9": "2048x1152",
      "9:16": "1152x2048",
      "4:3": "1536x1152",
      "3:4": "1152x1536",
      "3:2": "1536x1024",
      "2:3": "1024x1536",
      "1:1": isHigh && !isDraft ? "2048x2048" : "1024x1024",
    };
    if (ratioSizes[key]) return { size: ratioSizes[key], reason: `描述包含 ${key} 比例` };
  }

  if (is4k) {
    return isVertical
      ? { size: "2160x3840", reason: "描述要求竖版 4K" }
      : { size: "3840x2160", reason: "描述要求横版 4K" };
  }
  if (isMobile) return { size: "1152x2048", reason: "描述用于手机或 9:16 内容" };
  if (isWide) return { size: isDraft ? "1536x1024" : "2048x1152", reason: "描述适合横幅或宽屏画面" };
  if (isVertical) return { size: isHigh ? "1152x2048" : "1024x1536", reason: "描述适合竖版海报或封面" };
  if (isSquare) return { size: isHigh ? "2048x2048" : "1024x1024", reason: "描述适合方形画面" };
  if (includesAny(text, ["室内", "建筑", "风景", "场景", "空间", "interior", "architecture", "landscape scene"])) {
    return { size: isHigh ? "2048x1152" : "1536x1024", reason: "场景类描述默认使用横向构图" };
  }
  return { size: "1024x1024", reason: "未指定用途，使用通用方形尺寸" };
}

function jpegDimensions(buffer) {
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return { width: null, height: null };
}

function webpDimensions(buffer) {
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return { width: null, height: null };
}

export function detectImageInfo(buffer, contentType = "") {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", ...jpegDimensions(buffer) };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { extension: "webp", ...webpDimensions(buffer) };
  }
  if (contentType.includes("png")) return { extension: "png", width: null, height: null };
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return { extension: "jpg", width: null, height: null };
  if (contentType.includes("webp")) return { extension: "webp", width: null, height: null };
  throw new Error("接口返回的内容不是可识别的 PNG、JPEG 或 WebP 图片");
}

function decodeDataUrl(value) {
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
  if (!match) return null;
  return { buffer: Buffer.from(match[2], "base64"), contentType: match[1] };
}

async function imageBytes(item, endpoint, timeoutMs) {
  if (typeof item.b64_json === "string" && item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, "base64"), contentType: "" };
  }
  if (typeof item.url === "string" && item.url) {
    const dataUrl = decodeDataUrl(item.url);
    if (dataUrl) return dataUrl;

    const response = await fetch(new URL(item.url, endpoint), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`下载图片失败: HTTP ${response.status}`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "",
    };
  }
  throw new Error("响应中没有 data[0].b64_json 或 data[0].url");
}

class ApiError extends Error {
  constructor(status, body) {
    super(`生图接口返回 HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function isSizeError(error) {
  return error instanceof ApiError
    && error.status === 400
    && /size|resolution|dimension|width|height|尺寸|分辨率/i.test(JSON.stringify(error.body));
}

function fallbackSize(size) {
  const [width, height] = size.split("x").map(Number);
  if (width > height) return "1536x1024";
  if (height > width) return "1024x1536";
  return "1024x1024";
}

function sanitize(value, apiKey) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replaceAll(apiKey, "[REDACTED]").slice(0, 4_000);
}

async function callApi({ endpoint, apiKey, model, prompt, size, quality, timeoutMs }) {
  const payload = { model, prompt, size, n: 1 };
  if (quality && quality !== "auto") payload.quality = quality;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
}

async function generateOne(context, requestNumber) {
  const startedAt = performance.now();
  let requestSize = context.size;
  let usedFallback = false;

  try {
    let body;
    try {
      body = await callApi({ ...context, size: requestSize });
    } catch (error) {
      const nextSize = fallbackSize(requestSize);
      if (!isSizeError(error) || nextSize === requestSize) throw error;
      requestSize = nextSize;
      usedFallback = true;
      body = await callApi({ ...context, size: requestSize });
    }

    const item = body.data?.[0] || {};
    const { buffer, contentType } = await imageBytes(item, context.endpoint, context.timeoutMs);
    if (buffer.length < 32) throw new Error("接口返回的图片文件过小或已损坏");
    const imageInfo = detectImageInfo(buffer, contentType);
    const extension = imageInfo.extension;
    const filename = `image-${context.runId}-${String(requestNumber).padStart(3, "0")}.${extension}`;
    const outputPath = resolve(context.outputDir, filename);
    await writeFile(outputPath, buffer, { flag: "wx" });

    return {
      ok: true,
      requestNumber,
      path: outputPath,
      bytes: buffer.length,
      requestedSize: requestSize,
      actualSize: imageInfo.width && imageInfo.height ? `${imageInfo.width}x${imageInfo.height}` : null,
      size: imageInfo.width && imageInfo.height ? `${imageInfo.width}x${imageInfo.height}` : requestSize,
      usedFallback,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    return {
      ok: false,
      requestNumber,
      status,
      code: status === 401 || status === 403 ? "AUTH_FAILED" : status === 429 ? "RATE_LIMITED" : "GENERATION_FAILED",
      error: sanitize(error instanceof ApiError ? error.body : error.message, context.apiKey),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  }
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

  const model = options.model || status.config.model || "gpt-image-2";
  const sizeSelection = options.size && options.size !== "auto"
    ? normalizeExplicitSize(options.size, model)
    : inferSize(prompt, model);
  const timeoutMs = options.timeoutMs || status.config.timeoutMs;
  const outputDir = resolve(options.outputDir || "outputs/my-image");
  const concurrency = Math.min(options.concurrency, options.count);
  const payloadPreview = {
    endpoint: status.config.endpoint,
    model,
    prompt,
    size: sizeSelection.size,
    quality: options.quality || null,
    count: options.count,
    concurrency,
    outputDir,
    sizeReason: sizeSelection.reason,
  };

  if (options.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...payloadPreview }, null, 2));
    return;
  }

  await mkdir(outputDir, { recursive: true });
  const context = {
    endpoint: status.config.endpoint,
    apiKey: status.config.apiKey,
    model,
    prompt,
    size: sizeSelection.size,
    quality: options.quality,
    timeoutMs,
    outputDir,
    runId: `${timestamp()}-${process.pid}`,
  };

  const results = new Array(options.count);
  let nextRequest = 1;
  async function worker() {
    while (nextRequest <= options.count) {
      const requestNumber = nextRequest++;
      results[requestNumber - 1] = await generateOne(context, requestNumber);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const succeeded = results.filter((item) => item.ok).length;
  const summary = {
    ok: succeeded === options.count,
    model,
    requestedSize: sizeSelection.size,
    sizeReason: sizeSelection.reason,
    count: options.count,
    succeeded,
    failed: options.count - succeeded,
    outputDir,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || "FATAL", error: error.message }, null, 2));
    process.exitCode = error.code === "CONFIG_REQUIRED" ? 2 : 1;
  });
}
