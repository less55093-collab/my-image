# My Image

`my-image` 是一个面向 Codex 的自定义生图 Skill。用户只需要描述想要的图片；Skill 会自动检查配置、引导填写 Base URL 和 API Key、选择 `gpt-image-2`、推断合适的尺寸，并在生成后保存、检查和展示图片。

它适合使用第三方 OpenAI Images API 兼容服务，同时不要求普通用户理解环境变量、JSON 或命令行参数。

## 功能

- 首次调用自动检查配置，不要求用户预先说“配置”。
- 自动打开本地配置页，只需填写 Base URL 和 API Key。
- 默认模型为 `gpt-image-2`，支持按单次请求覆盖。
- 根据头像、海报、横幅、室内场景、手机壁纸和 4K 等描述自动选择尺寸。
- 支持一次生成 1 到 10 张图片，并限制并发，避免无意增加费用。
- 兼容 `data[0].b64_json` 和 `data[0].url` 两种 OpenAI 风格响应。
- 支持 PNG、JPEG 和 WebP，并读取文件中的实际宽高。
- 第三方接口拒绝尺寸时，仅对明确的尺寸错误执行一次兼容降级。
- API Key 不写入仓库，不在正常输出中回显。
- 生成后由 Codex 检查图片，并通过绝对路径直接显示。

## 运行要求

- 支持 Skills 的 Codex 环境。
- Node.js 20 或更高版本。
- 一个支持以下接口的 OpenAI 兼容生图服务：

  ```text
  POST <BASE_URL>/images/generations
  ```

- 服务至少接受 `model`、`prompt`、`size` 和 `n` 字段。
- 服务返回 `data[0].b64_json` 或 `data[0].url`。

## 安装

### macOS / Linux

```bash
git clone https://gitee.com/chenyifan888/my-image.git \
  "${CODEX_HOME:-$HOME/.codex}/skills/my-image"
```

### Windows PowerShell

```powershell
git clone https://gitee.com/chenyifan888/my-image.git `
  "$env:USERPROFILE\.codex\skills\my-image"
```

安装后新建一个 Codex 任务或重启 Codex，使 Skill 被重新发现。

更新已有安装：

```bash
git -C "${CODEX_HOME:-$HOME/.codex}/skills/my-image" pull --ff-only
```

## 使用

直接调用 Skill 并描述图片：

```text
$my-image 帮我生成一张真实的小猫照片，暖色轮廓光，背景虚化
```

也可以描述用途、比例、尺寸或数量：

```text
$my-image 生成 3 张网站首屏横幅，现代建筑摄影，16:9
```

```text
$my-image 生成一张 9:16 手机壁纸，雨夜霓虹街道，照片级真实
```

## 首次配置

第一次调用时，Skill 会先检查用户配置。如果缺少 Base URL 或 API Key，它会自动启动仅监听 `127.0.0.1` 的本地配置页。

用户在页面中填写：

- `Base URL`，例如 `https://example.com/v1`
- `API Key`
- 模型，可不修改，默认是 `gpt-image-2`

保存后，Skill 会继续执行用户原来的生图请求，不需要重新描述。

配置文件位于：

| 系统 | 默认路径 |
| --- | --- |
| macOS / Linux | `${XDG_CONFIG_HOME:-~/.config}/my-image/.env` |
| Windows | `%APPDATA%\my-image\.env` |

可通过 `MY_IMAGE_GEN_ENV_FILE` 指定其他位置。

配置内容类似：

```dotenv
OPENAI_BASE_URL="https://example.com/v1"
OPENAI_API_KEY="replace-with-your-key"
IMAGE_MODEL="gpt-image-2"
IMAGE_SIZE="auto"
TIMEOUT_MS="300000"
```

不要把真实 `.env`、API Key 或包含凭据的截图提交到仓库或 Issue。

## 自动尺寸选择

用户明确指定尺寸或比例时优先遵从。否则 Skill 会根据描述推断：

| 描述或用途 | 默认请求尺寸 |
| --- | --- |
| 头像、图标、方形产品图 | `1024x1024` |
| 横向场景、建筑、室内空间 | `1536x1024` |
| 网站首屏、横幅、16:9 壁纸 | `2048x1152` |
| 海报、书封、竖版插画 | `1024x1536` |
| 手机壁纸、Story、9:16 内容 | `1152x2048` |
| 明确要求横版 4K | `3840x2160` |
| 明确要求竖版 4K | `2160x3840` |

第三方服务可能忽略请求尺寸。生成器会读取最终 PNG、JPEG 或 WebP 文件中的实际宽高，并在结果中分别记录 `requestedSize` 和 `actualSize`。

## API 兼容格式

请求示例：

```json
{
  "model": "gpt-image-2",
  "prompt": "A photorealistic kitten with warm rim light",
  "size": "1024x1024",
  "n": 1
}
```

支持 Base64 响应：

```json
{
  "data": [
    { "b64_json": "..." }
  ]
}
```

也支持 URL 响应：

```json
{
  "data": [
    { "url": "https://example.com/generated/image.png" }
  ]
}
```

## 脚本

### 检查配置

```bash
node scripts/verify-config.mjs --json
```

该命令只输出 `hasApiKey`，不会输出 API Key 本身。

### 打开配置页

```bash
node scripts/configure.mjs
```

仅测试配置页而不自动打开浏览器：

```bash
node scripts/configure.mjs --no-open
```

### 生成图片

```bash
node scripts/generate.mjs \
  --prompt "一只真实的小猫，暖色轮廓光" \
  --size auto \
  --count 1 \
  --output-dir outputs/my-image
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--prompt` | 直接提供提示词 |
| `--prompt-file` | 从 UTF-8 文件读取长提示词 |
| `--size` | `auto` 或 `WIDTHxHEIGHT` |
| `--model` | 覆盖默认模型 |
| `--count` | 图片数量，1 到 10 |
| `--concurrency` | 并发数，1 到 4 |
| `--quality` | `low`、`medium`、`high` 或 `auto` |
| `--output-dir` | 输出目录 |
| `--timeout-ms` | 单次请求超时 |
| `--dry-run` | 只显示脱敏后的请求计划，不调用接口 |

## 测试

仓库测试不调用真实付费接口，只使用本地模拟服务和假 Key：

```bash
npm test
```

测试覆盖：

- `.env` 创建、读取和权限。
- 本地浏览器配置流程。
- API Key 输出脱敏。
- 自动尺寸推断。
- PNG、JPEG 和 WebP 实际宽高读取。
- Base64 和 URL 图片响应。
- 尺寸拒绝后的单次兼容降级。
- `401` 鉴权错误分类。
- 多图并发和文件名唯一性。

## 目录结构

```text
my-image/
├── SKILL.md
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── agents/
│   └── openai.yaml
├── scripts/
│   ├── configure.mjs
│   ├── generate.mjs
│   └── verify-config.mjs
└── tests/
    └── my-image.test.mjs
```

## 已知限制

- 当前只支持新图片生成，不支持图片编辑、蒙版、局部重绘或透明背景编辑。
- 接口必须兼容 OpenAI Images API 的核心请求和响应结构。
- 配置文件包含明文 API Key。脚本会在 macOS/Linux 设置 `0600` 权限，并在 Windows 尝试收紧 ACL，但用户仍应保护本地账户和磁盘。
- macOS 已完成真实接口验证；Windows 和 Linux 路径有自动化覆盖，但仍建议在目标系统做一次实际配置与生成验收。

## 许可证

当前仓库尚未声明开源许可证。未经仓库所有者明确许可，不应假定代码可以被复制、修改或重新分发。
