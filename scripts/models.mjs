#!/usr/bin/env node

// 列出上游接口可用的模型（OpenAI 兼容 GET {base}/models）。
// 用法:
//   node scripts/models.mjs                  打印模型列表
//   node scripts/models.mjs --json           打印 JSON
//   node scripts/models.mjs --set <model>    拉取列表、确认存在后写回配置并作为默认模型

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchModels, loadConfig, saveConfig } from "./verify-config.mjs";

function parseArgs(argv) {
  const options = { json: false, set: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--set") options.set = argv[++index];
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const status = await loadConfig();
  if (!status.ok) {
    const error = new Error("my-image 尚未配置，请先运行 configure.mjs");
    error.code = "CONFIG_REQUIRED";
    throw error;
  }

  let result;
  try {
    result = await fetchModels({
      baseUrl: status.config.baseUrl,
      apiKey: status.config.apiKey,
      timeoutMs: Math.min(status.config.timeoutMs, 60_000),
    });
  } catch (error) {
    const code = error.status === 401 || error.status === 403 ? "AUTH_FAILED" : "MODELS_FETCH_FAILED";
    const summary = { ok: false, code, status: error.status || 0, error: error.message };
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  const summary = {
    ok: true,
    endpoint: result.endpoint,
    currentModel: status.config.model,
    count: result.models.length,
    models: result.models,
  };

  if (options.set) {
    if (!result.models.includes(options.set)) {
      summary.ok = false;
      summary.code = "MODEL_NOT_FOUND";
      summary.error = `上游模型列表中不存在: ${options.set}`;
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = 1;
      return;
    }
    const saved = await saveConfig({
      baseUrl: status.config.baseUrl,
      apiKey: status.config.apiKey,
      model: options.set,
    });
    summary.saved = { configPath: saved.configPath, model: saved.model };
    summary.currentModel = saved.model;
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`接口: ${summary.endpoint}`);
    console.log(`当前默认模型: ${summary.currentModel}`);
    for (const model of result.models) console.log(`- ${model}`);
    if (summary.saved) console.log(`已保存默认模型: ${summary.saved.model}`);
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || "FATAL", error: error.message }, null, 2));
    process.exitCode = error.code === "CONFIG_REQUIRED" ? 2 : 1;
  });
}
