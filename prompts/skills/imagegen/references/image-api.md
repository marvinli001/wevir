<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2025 OpenAI
From openai/codex, commit 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d, codex-rs/skills/src/assets/samples/imagegen/references/image-api.md. Changes for Wevir: trimmed to what `wevir_image_generate` accepts; the CLI, endpoint, input-fidelity, compression, moderation and chroma-key notes are removed.
-->

# Image model quick reference

Limits for the arguments of `wevir_image_generate`. Codex's built-in `image_gen` does not take these arguments.

Which models are available depends on the image models configured for the session's provider; the tool's `model` argument accepts only those. OpenAI-compatible services may serve other models with their own limits; when a call fails on an option, follow the service's error.

## Model summary

| Model | Quality | Sizes | Transparent background | Recommended use |
| --- | --- | --- | --- | --- |
| `gpt-image-2` | `low`, `medium`, `high`, `auto` | `auto` or flexible sizes that satisfy the constraints below | No | Default: high-quality generation and editing, text-heavy images, photorealism, compositing, identity-sensitive edits |
| `gpt-image-1.5` | `low`, `medium`, `high`, `auto` | `1024x1024`, `1024x1536`, `1536x1024`, `auto` | Yes | True transparent-background output and backward-compatible workflows |
| `gpt-image-1` | `low`, `medium`, `high`, `auto` | `1024x1024`, `1024x1536`, `1536x1024`, `auto` | Yes | Legacy compatibility |
| `gpt-image-1-mini` | `low`, `medium`, `high`, `auto` | `1024x1024`, `1024x1536`, `1536x1024`, `auto` | Yes | Cost-sensitive drafts and lower-stakes previews |

## gpt-image-2 sizes

`gpt-image-2` accepts `auto` or any `WIDTHxHEIGHT` size that satisfies all constraints:

- Maximum edge length must be less than or equal to `3840px`.
- Both edges must be multiples of `16px`.
- Long edge to short edge ratio must not exceed `3:1`.
- Total pixels must be at least `655,360` and no more than `8,294,400`.

Popular sizes:

| Label | Size | Notes |
| --- | --- | --- |
| Square | `1024x1024` | Typical fast default |
| Landscape | `1536x1024` | Standard landscape |
| Portrait | `1024x1536` | Standard portrait |
| 2K square | `2048x2048` | Larger square output |
| 2K landscape | `2048x1152` | Widescreen output |
| 4K landscape | `3840x2160` | Widescreen 4K output |
| 4K portrait | `2160x3840` | Vertical 4K output |
| Auto | `auto` | Default size |

Square images are typically fastest to generate. For 4K-style output, use `3840x2160` or `2160x3840`.

## Arguments

- `prompt`: text prompt.
- `model`: one of the provider's image models; omitted means the provider's first.
- `n`: variants of one prompt, 1–4.
- `size`: `auto` or `WIDTHxHEIGHT`; flexible sizes only for `gpt-image-2`, the older models take the three fixed sizes or `auto`.
- `quality`: `low`, `medium`, `high`, or `auto`.
- `background`: output transparency (`transparent`, `opaque`, or `auto`); not the same thing as the prompt's visual scene/backdrop. `transparent` needs a model that supports it and `outputFormat` `png` or `webp`.
- `outputFormat`: `png` (default), `jpeg`, `webp`.
- `name`: file name stem for the saved files.

## Edit arguments

- `images`: one or more input image paths, up to 16. Giving them makes the call an edit.
- `mask`: optional PNG with an alpha channel; transparent pixels mark the area to change. It applies to the first image and must match its size.

## Limits and notes

- Input images and masks must be under 50MB.
- Masking is prompt-guided; exact shapes are not guaranteed.
- Large sizes and high quality increase latency and cost.
- Use `quality: low` for fast drafts, thumbnails, and quick iterations. Use `medium` or `high` for final assets, dense text, diagrams, identity-sensitive edits, or high-resolution outputs.
- If a call fails because a specific option is unsupported by the selected model, retry without that option only when the user did not require it. If true transparency is required, ask before switching to a model that supports it instead of dropping `background: transparent`, unless the user already chose that model.
