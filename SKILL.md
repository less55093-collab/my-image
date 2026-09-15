---
name: my-image
description: Generate, edit, and display images through a user-supplied OpenAI-compatible Images API. Use when the user invokes $my-image or asks to create or modify AI images with their own Base URL and API key, including first-time setup, gpt-image-2.5 generation, image edits, multi-image compositing, optional masks, upstream model listing and switching, automatic resolution selection, local saving, and inline result display.
---

# My Image

通过用户的 OpenAI 兼容接口生成或编辑图片。请求模式由 `IMAGE_MODE` 配置决定：

- `auto`（默认）：优先走异步端点（`/images/generations/async`、`/images/edits/async` + 轮询 `/images/tasks/:id`），网关会把图片转存到对象存储（如 R2）；如果中转站不支持异步（提交返回 404/405/501），自动降级为同步端点。
- `async`：只用异步，失败不降级。
- `sync`：只用同步端点（`/images/generations`、`/images/edits`），兼容性最好。

配置方式：环境变量或在 configure 的 stdin JSON / 配置文件中加 `"mode": "sync"` 等。脚本输出 JSON 中的 `transport` 字段标明本次实际走了 `async` 还是 `sync`。

## 快速上手（agent 按此顺序执行）

**第 0 步**：记住用户原始的生图/改图需求，配置过程中不要让用户重复描述。

**第 1 步：检查配置**（`<skill-dir>` 是本 SKILL.md 所在目录）：

```bash
node <skill-dir>/scripts/verify-config.mjs --json
```

输出 JSON 中 `ok: true` 就直接跳到第 3 步；否则进入第 2 步配置。配置只需做一次，之后所有会话复用。

**第 2 步：写入配置**

- 用户已经在消息里同时给出 Base URL 和 API Key 时，直接用 stdin 写入（**不要把 key 放进命令行参数、文件或回显输出**）：

  ```bash
  printf '%s' '{"baseUrl":"<base-url>","apiKey":"<api-key>","model":"gpt-image-2.5","mode":"auto"}' \
    | node <skill-dir>/scripts/configure.mjs --stdin-json
  ```

- 用户没给全时，运行 `node <skill-dir>/scripts/configure.mjs`，它会打开本地浏览器表单。把输出的 `MY_IMAGE_SETUP_URL` 转达给用户，等待 `MY_IMAGE_CONFIG_SAVED`。

配置写入后重新执行第 1 步确认 `ok: true`。配置文件位置：`${XDG_CONFIG_HOME:-~/.config}/my-image/.env`（Windows: `%APPDATA%\my-image\.env`），可用 `MY_IMAGE_GEN_ENV_FILE` 覆盖。

**第 3 步：生图**（无现成图片要改时）：

```bash
node <skill-dir>/scripts/generate.mjs \
  --prompt "<提示词>" \
  --size auto \
  --count 1 \
  --output-dir <workspace>/outputs/my-image
```

**改图**（用户提供图片要求修改时，先用 `view_image` 看过输入图）：

```bash
node <skill-dir>/scripts/edit.mjs \
  --image <输入图绝对路径> \
  --prompt "<修改要求，明确说什么变、什么保持不变>" \
  --size auto \
  --output-dir <workspace>/outputs/my-image
```

多图合成/参考：重复 `--image`（最多 16 张，按顺序在提示词里用「第 1 张」「第 2 张」说明角色）。蒙版用 `--mask <png>`（必须与第一张图同尺寸、含 Alpha）。

**第 4 步：展示结果**。脚本输出 JSON，其中 `results[].path` 是图片绝对路径。对每个成功路径：用 `view_image` 检查非空白、符合描述，然后用 Markdown 图片语法和绝对路径内联展示，并简要报告实际模型、尺寸、成功张数。

## 获取上游模型

上游可用模型通过 OpenAI 兼容的 `GET {base}/models` 查询：

```bash
node <skill-dir>/scripts/models.mjs            # 人类可读列表
node <skill-dir>/scripts/models.mjs --json     # JSON，agent 优先用这个
node <skill-dir>/scripts/models.mjs --set gpt-image-2.5   # 校验存在后写回配置，设为默认模型
```

何时使用：用户问「有哪些模型」「换个模型」「当前用的什么模型」，或默认模型报 `model not found` 类错误需要挑选替代模型时。`--set` 只会接受上游列表中真实存在的模型。

## 参数规则

- **模型**：默认 `gpt-image-2.5`（写在配置里）。仅在用户明确点名时用 `--model <名字>` 覆盖；不要静默降级。
- **尺寸**：用户给了明确尺寸/比例就照用（`--size 1536x1024`）；否则 `--size auto`，由脚本按描述推断：
  - 头像/图标/方形：`1024x1024`
  - 横向场景/建筑/室内：`1536x1024`
  - 网站首屏/横幅/16:9：`2048x1152`
  - 竖版海报/封面：`1024x1536`
  - 手机壁纸/9:16：`1152x2048`
  - 明确 4K：`3840x2160` 或 `2160x3840`
- **质量**：用户明确要「草稿/快速预览」用 `--quality low`，明确要「最终稿/印刷/高清」用 `--quality high`；其他情况省略 `--quality` 以兼容第三方网关。
- **数量**：默认 1 张；用户明确要多张时最多 10 张，`--concurrency` 不超过 2（用户明确要求快时最多 4）。
- **长提示词**：含换行或 shell 特殊字符时写入工作区临时文件，用 `--prompt-file <路径>` 传入，完成后删除。临时文件里绝不放 API Key。
- **输出目录**：用户指定就用用户的；否则用当前工作区 `outputs/my-image/`。所有路径参数一律用绝对路径。

## 错误处理

脚本输出的 JSON 里 `code` 字段决定动作：

- `CONFIG_REQUIRED` → 回到第 2 步配置。
- `AUTH_FAILED`（401/403）→ 凭据无效，重新配置后再继续。
- `RATE_LIMITED`（429）→ 停止，不要自动重试，把控制权交给用户（涉及计费）。
- 其他失败 → 报告已脱敏的错误信息；改图失败不要自动重试（可能产生不同结果或重复计费）。

## 安全要求

- 永远不要在回复、命令行参数、源码、补丁中打印 API Key。
- 配置通过 `configure.mjs --stdin-json` 的标准输入或本地浏览器表单写入，文件权限自动设为 0600。

## 能力边界

支持文生图和提示词引导的改图；不保证像素级精确的蒙版边界、确定性的身份保持、分层源文件或透明背景输出。
