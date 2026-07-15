---
name: my-image
description: Generate, edit, and display images through a user-supplied OpenAI-compatible Images API. Use when the user invokes $my-image or asks to create or modify AI images with their own Base URL and API key, including first-time setup, gpt-image-2 generation, image edits, multi-image compositing, optional masks, automatic resolution selection, local saving, and inline result display.
---

# My Image

Generate or edit images through the user's OpenAI-compatible `/images/generations` and `/images/edits` endpoints. Keep the interaction usable for someone who only knows their Base URL, API key, source image, and desired result.

## Workflow

1. Preserve the user's original image request before checking configuration. Do not make them repeat it after setup.
2. Resolve this skill directory and run:

   ```bash
   node <skill-dir>/scripts/verify-config.mjs --json
   ```

3. If configuration is missing or invalid, start setup automatically. Do not require the user to say "configure" first.
4. Treat a request that changes, removes, replaces, combines, extends, or preserves part of an existing image as an edit. Treat a request without an edit target as generation.
5. Choose the prompt, model, size, quality, count, concurrency, and output directory from the request.
6. Run `scripts/generate.mjs` or `scripts/edit.mjs`, parse its JSON result, inspect every output image, and show valid images inline using absolute paths.

## First-Time Setup

Default to the local setup page:

```bash
node <skill-dir>/scripts/configure.mjs
```

The script opens a browser form for Base URL and API key. Tell the user only that configuration is required and the secure local form has opened. If automatic opening fails, relay the `MY_IMAGE_SETUP_URL` printed by the script. Wait for `MY_IMAGE_CONFIG_SAVED`, rerun `verify-config.mjs`, then continue the preserved image request.

If the user already voluntarily included both values in the current message, do not ask them to repeat the secret and never echo it. Start `configure.mjs --stdin-json`, send the JSON only through the process standard input, close stdin, and never place the API key in command arguments, source files, patches, or displayed output.

Configuration is stored outside the skill folder:

- macOS/Linux: `${XDG_CONFIG_HOME:-~/.config}/my-image/.env`
- Windows: `%APPDATA%\my-image\.env`
- Override: `MY_IMAGE_GEN_ENV_FILE`

The default model is `gpt-image-2`. Treat HTTP `401` or `403` as invalid credentials: reopen setup and retry only after configuration succeeds. Never print the API key. Do not automatically retry `429` responses.

## Generation Parameters

Honor explicit user dimensions or aspect ratios first. Otherwise pass `--size auto`; the generator infers a suitable resolution from the description instead of forcing a square image.

The built-in selection includes:

- avatar, icon, or square product image: `1024x1024`
- landscape scene, architecture, or interior: `1536x1024`
- website hero, banner, or 16:9 wallpaper: `2048x1152`
- portrait poster, book cover, or vertical illustration: `1024x1536`
- mobile wallpaper, story, or 9:16 content: `1152x2048`
- explicit 4K landscape or portrait: `3840x2160` or `2160x3840`

Use `--quality low` for an explicit draft or fast preview and `--quality high` for an explicit final, print, or high-detail request. Otherwise omit `--quality` for compatibility with third-party gateways.

Default to one image. Honor an explicit count up to 10. Use concurrency `1` for one image and at most `2` for ordinary multi-image requests unless the user explicitly prioritizes speed; never exceed `4`. Distinct concepts need distinct prompts rather than repeated copies of one prompt.

Use the configured model unless the user explicitly names another model. Do not silently replace `gpt-image-2` with an older model.

## Running The Generator

For long, multiline, or shell-sensitive prompts, write a temporary prompt file inside the current workspace and use `--prompt-file`. Remove the temporary prompt file after the command completes. Never put the API key in that file.

Example:

```bash
node <skill-dir>/scripts/generate.mjs \
  --prompt-file <workspace-temp-prompt> \
  --size auto \
  --count 1 \
  --concurrency 1 \
  --output-dir <absolute-output-directory>
```

Use a user-specified destination when present. Otherwise save under the current workspace at `outputs/my-image/`. The generator accepts Base64 image data and downloadable image URLs, validates PNG/JPEG/WebP signatures, avoids overwriting files, and makes one compatibility fallback only when the API explicitly rejects the requested dimensions.

## Editing Existing Images

Use `scripts/edit.mjs` when the user wants to change an existing image. Inspect each local input with `view_image` before calling the API. Identify the edit target separately from supporting reference or compositing images.

Build the edit prompt with explicit invariants: state what must change and what must remain unchanged. Preserve identity, pose, composition, product geometry, text, lighting, or background whenever the user did not ask to alter them. Do not promise pixel-perfect mask boundaries.

Use one repeated `--image` argument per input image. Their order is meaningful; describe each input by index and role in the prompt. A provided mask must be a PNG with Alpha or transparency information and the same dimensions as the first input image.

Example:

```bash
node <skill-dir>/scripts/edit.mjs \
  --image <absolute-edit-target> \
  --prompt-file <workspace-temp-prompt> \
  --size auto \
  --count 1 \
  --output-dir <absolute-output-directory>
```

Optional mask:

```bash
node <skill-dir>/scripts/edit.mjs \
  --image <absolute-edit-target> \
  --mask <absolute-png-mask> \
  --prompt-file <workspace-temp-prompt> \
  --output-dir <absolute-output-directory>
```

For multiple inputs, use `--image` repeatedly. The editor accepts PNG, JPEG, and WebP inputs up to 50MB each, limits all input data to 200MB, and supports up to 16 input images. Default `--size auto` preserves the first image's broad orientation. Do not automatically retry failed edits because a retry may produce a different result or additional billing.

## Result Handling

Read the generator's JSON summary. For each successful path:

1. Load the local file with `view_image`.
2. Confirm it is nonblank, readable, and broadly matches the requested subject and orientation.
3. Display it in the response with standard Markdown image syntax and the absolute file path.
4. Report the actual model, dimensions, and number of successful images concisely.

If some variants fail, show the successful ones and report the failed count. If all fail, report the sanitized API error. On `AUTH_FAILED`, run setup; on `RATE_LIMITED`, stop without an automatic retry so the user retains control over additional billing.

This skill supports generation and prompt-guided edits. It does not guarantee exact pixel boundaries, deterministic identity preservation, native layered files, or transparent-background output.
