#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_TIMEOUT_MS = 300_000;

export function getConfigPath(env = process.env) {
  if (env.MY_IMAGE_GEN_ENV_FILE) {
    return isAbsolute(env.MY_IMAGE_GEN_ENV_FILE)
      ? env.MY_IMAGE_GEN_ENV_FILE
      : resolve(env.MY_IMAGE_GEN_ENV_FILE);
  }

  if (platform() === "win32") {
    const appData = env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "my-image", ".env");
  }

  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "my-image", ".env");
}

function decodeValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDotEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;

    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    values[key] = decodeValue(normalized.slice(separator + 1));
  }
  return values;
}

function firstValue(env, fileValues, key, fallback = "") {
  if (typeof env[key] === "string" && env[key].trim()) return env[key].trim();
  if (typeof fileValues[key] === "string" && fileValues[key].trim()) return fileValues[key].trim();
  return fallback;
}

export function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL 不能为空");

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL 必须是完整的 http:// 或 https:// 地址");
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("Base URL 只支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL 中不能包含用户名或密码");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Base URL 中不能包含查询参数或片段");
  }

  return trimmed;
}

export function imageEndpoint(baseUrl, operation) {
  const suffix = operation === "edit" ? "edits" : "generations";
  if (/\/images\/(?:generations|edits)$/.test(baseUrl)) {
    return baseUrl.replace(/\/images\/(?:generations|edits)$/, `/images/${suffix}`);
  }
  return `${baseUrl}/images/${suffix}`;
}

export function generationEndpoint(baseUrl) {
  return imageEndpoint(baseUrl, "generate");
}

export function editEndpoint(baseUrl) {
  return imageEndpoint(baseUrl, "edit");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function loadConfig(options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath || getConfigPath(env);
  let fileValues = {};
  let configExists = true;
  const warnings = [];

  try {
    fileValues = parseDotEnv(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") warnings.push(`无法读取配置文件: ${error.message}`);
    configExists = false;
  }

  const apiKey = firstValue(env, fileValues, "OPENAI_API_KEY");
  const rawBaseUrl = firstValue(env, fileValues, "OPENAI_BASE_URL");
  const model = firstValue(env, fileValues, "IMAGE_MODEL", DEFAULT_MODEL);
  const defaultSize = firstValue(env, fileValues, "IMAGE_SIZE", "auto");
  const timeoutMs = positiveInteger(
    firstValue(env, fileValues, "TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)),
    DEFAULT_TIMEOUT_MS,
  );

  const missing = [];
  if (!apiKey) missing.push("OPENAI_API_KEY");
  if (!rawBaseUrl) missing.push("OPENAI_BASE_URL");

  let baseUrl = "";
  let endpoint = "";
  if (rawBaseUrl) {
    try {
      baseUrl = normalizeBaseUrl(rawBaseUrl);
      endpoint = generationEndpoint(baseUrl);
    } catch (error) {
      warnings.push(error.message);
    }
  }

  if (configExists && platform() !== "win32") {
    try {
      const mode = (await stat(configPath)).mode & 0o777;
      if ((mode & 0o077) !== 0) warnings.push("配置文件权限过宽，建议设为 0600");
    } catch (error) {
      warnings.push(`无法检查配置文件权限: ${error.message}`);
    }
  }

  return {
    ok: missing.length === 0 && Boolean(endpoint) && warnings.every((item) => !item.includes("Base URL")),
    configPath,
    configExists,
    missing,
    warnings,
    config: {
      apiKey,
      hasApiKey: Boolean(apiKey),
      baseUrl,
      endpoint,
      model,
      defaultSize,
      timeoutMs,
    },
  };
}

function envLine(key, value) {
  return `${key}=${JSON.stringify(String(value))}`;
}

export async function saveConfig(values, options = {}) {
  const baseUrl = normalizeBaseUrl(values.baseUrl);
  const apiKey = String(values.apiKey || "").trim();
  const model = String(values.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const configPath = options.configPath || getConfigPath(options.env || process.env);

  if (!apiKey) throw new Error("API Key 不能为空");
  if (/\r|\n/.test(apiKey)) throw new Error("API Key 格式无效");
  if (/\r|\n/.test(model)) throw new Error("模型名称格式无效");

  const content = [
    "# Managed by the my-image skill. Do not commit this file.",
    envLine("OPENAI_BASE_URL", baseUrl),
    envLine("OPENAI_API_KEY", apiKey),
    envLine("IMAGE_MODEL", model),
    envLine("IMAGE_SIZE", values.defaultSize || "auto"),
    envLine("TIMEOUT_MS", values.timeoutMs || DEFAULT_TIMEOUT_MS),
    "",
  ].join("\n");

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(tempPath, 0o600).catch(() => {});

  try {
    await rename(tempPath, configPath);
  } catch (error) {
    if (platform() !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await unlink(configPath).catch((unlinkError) => {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    });
    await rename(tempPath, configPath);
  }

  await chmod(configPath, 0o600).catch(() => {});
  return { configPath, baseUrl, model };
}

function publicStatus(status) {
  return {
    ok: status.ok,
    configPath: status.configPath,
    configExists: status.configExists,
    missing: status.missing,
    warnings: status.warnings,
    config: {
      hasApiKey: status.config.hasApiKey,
      baseUrl: status.config.baseUrl,
      endpoint: status.config.endpoint,
      model: status.config.model,
      defaultSize: status.config.defaultSize,
      timeoutMs: status.config.timeoutMs,
    },
  };
}

async function main() {
  const status = await loadConfig();
  const json = process.argv.includes("--json");

  if (json) {
    console.log(JSON.stringify(publicStatus(status), null, 2));
  } else if (status.ok) {
    console.log(`配置有效: ${status.configPath}`);
    console.log(`接口: ${status.config.endpoint}`);
    console.log(`模型: ${status.config.model}`);
  } else {
    console.error(`配置尚未完成: ${status.configPath}`);
    if (status.missing.length) console.error(`缺少: ${status.missing.join(", ")}`);
    for (const warning of status.warnings) console.error(`提示: ${warning}`);
  }

  if (!status.ok) process.exitCode = 2;
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
