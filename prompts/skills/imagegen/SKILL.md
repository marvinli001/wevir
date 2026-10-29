---
name: imagegen
description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when the agent should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
metadata:
  short-description: Generate and edit images
---

<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2025 OpenAI
Wevir built-in skill. Adapted from openai/codex, commit 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d,
codex-rs/skills/src/assets/samples/imagegen/SKILL.md (Apache-2.0; see LICENSE.txt). Changes: the tool is Wevir's
`wevir_image_generate` (Codex's own `image_gen` where that is the tool listed); the Python CLI fallback, its
dependencies and the OPENAI_API_KEY setup are removed because Wevir's Host holds the provider key; edits take local
file paths; the save-path policy uses Wevir's generated-images folder; gpt-image-2 parameter guidance follows the
tool's arguments.
-->

# Image Generation Skill

Generates or edits images for the current project (for example website assets, game assets, UI mockups, product mockups, wireframes, logo design, photorealistic images, or infographics).

## Which tool

Use whichever image tool is in your tool list:

- **`wevir_image_generate`** (Wevir's app tool). It appears when the session's provider has image models configured (the `gpt-image-2` family or a compatible model). Wevir calls the provider with its stored key; never ask the user for an API key.
- **`image_gen`** (Codex's built-in tool). It appears in sessions signed in with ChatGPT. Follow the `image_gen` notes below where they differ.

If neither tool is listed, do not write scripts, call an image API yourself, or ask for an API key. Tell the user that image generation needs an image model: add one (for example `gpt-image-2`) to an OpenAI or OpenAI-compatible provider in Settings → Providers, then use that provider for the session.

Rules:
- If the tool fails, report the error. Retry only when the cause is clear and fixable (for example an unsupported size or option the user did not require); otherwise ask the user.
- The word `batch` does not change the tool. For many assets, issue one call per requested asset; use `n` only for variants of one prompt.
- Never silently switch to a different image model than the one the user asked for, or from `gpt-image-2` to an older model. Ask first unless the user named that model.

## `wevir_image_generate` arguments

- `prompt` (required): the full prompt; use the prompt schema below.
- `images`: local file paths, absolute or relative to the session folder, up to 16. When given, the call is an **edit** of these images; they can also serve as references for style, composition, or subjects. Refer to them in the prompt by index (`Image 1`, `Image 2`) in the order passed.
- `mask`: PNG with an alpha channel, edit only. Transparent pixels mark the area to change. Masking is prompt-guided; exact shapes are not guaranteed.
- `size`: `auto` or `WIDTHxHEIGHT` (see `references/image-api.md` for the limits).
- `quality`: `low`, `medium`, `high`, or `auto`. Use `low` for fast drafts and quick iterations; `medium`, `high`, or `auto` for final assets, dense text, diagrams, identity-sensitive edits, or large outputs.
- `background`: `auto`, `opaque`, or `transparent` (see "Transparent image requests").
- `n`: 1–4 variants of the same prompt.
- `model`: one of the provider's image models; omit to use the provider's first image model.
- `outputFormat`: `png` (default), `jpeg`, or `webp`. Transparency needs `png` or `webp`.
- `name`: file name stem for the saved images, short and descriptive (`hero-mug`, `item-icon-sword`).

The tool shows the images inline to the user and returns the absolute paths of the saved files plus the model used. To iterate on a result, pass its returned path in `images`.

## Save-path policy

- Wevir saves generated images under its data folder (`generated-images/<session>/`). That folder is Wevir's, not the project's.
- Do not rely on a destination argument; there is none. If a specific location is needed, generate first, then copy the selected output.
- Save-path precedence:
  1. If the user names a destination, copy the selected output there.
  2. If the image is meant for the current project, copy the final selected image into the workspace before finishing.
  3. If the image is only for preview or brainstorming, leave it where Wevir saved it; the user already sees it inline.
- Never leave a project-referenced asset only in Wevir's generated-images folder.
- Do not overwrite an existing asset unless the user explicitly asked for replacement; otherwise create a sibling versioned filename such as `hero-v2.png` or `item-icon-edited.png`.

## `image_gen` notes (Codex's built-in tool)

- `image_gen` takes a prompt; it does not expose `size`, `quality`, `background`, masks, output format, or paths. Do not invent those arguments.
- It edits images that are visible in the conversation (attachments or earlier results). To edit a local file, first load it with `view_image`, then proceed with the edit. Do not promise arbitrary file-path editing or masks through it.
- It saves images under `$CODEX_HOME/generated_images/...`; apply the save-path policy above to that folder.
- For transparent images, ask it for a genuinely transparent background and preserve the generated alpha.

Shared prompt guidance lives in `references/prompting.md` and `references/sample-prompts.md`. Model and size limits for `wevir_image_generate` are in `references/image-api.md`.

## When to use
- Generate a new image (concept art, product shot, cover, website hero)
- Generate a new image using one or more reference images for style, composition, or mood
- Edit an existing image (inpainting, lighting or weather transformations, background replacement, object removal, compositing, transparent background)
- Produce many assets or variants for one task

## When not to use
- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas
- Making a small project-local asset edit when the source file already exists in an editable native format
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap

## Decision tree

Think about two separate questions:

1. **Intent:** is this a new image or an edit of an existing image?
2. **Execution strategy:** is this one asset or many assets/variants?

Intent:
- If the user wants to modify an existing image while preserving parts of it, treat the request as **edit**.
- If the user provides images only as references for style, composition, mood, or subject guidance, treat the request as **generate** with references.
- If the user provides no images, treat the request as **generate**.

Edit semantics for `wevir_image_generate`:
- Pass the edit target and any supporting images as file paths in `images`. Earlier results can be passed by the paths the tool returned.
- If an image is only visible in the conversation and you have no file path for it, ask the user for the file.
- For edits, preserve invariants aggressively and save non-destructively by default.

Execution strategy:
- Produce many assets or variants by issuing one call per requested asset or variant.
- For many distinct assets, do not use `n` as a substitute for separate prompts. `n` is for variants of one prompt; distinct assets need distinct calls.

Assume the user wants a new image unless they clearly ask to change an existing one.

## Workflow
1. Check which image tool is available (see "Which tool").
2. Decide the intent: generate or edit.
3. Decide whether the output is preview-only or meant to be consumed by the current project.
4. Decide the execution strategy: single asset vs repeated calls vs `n` variants of one prompt.
5. Collect inputs up front: prompt(s), exact text (verbatim), constraints/avoid list, and any input images.
6. For every input image, label its role explicitly:
   - reference image
   - edit target
   - supporting insert/style/compositing input
7. If the user asked for a photo, illustration, sprite, product image, banner, or other explicitly raster-style asset, use the image tool rather than substituting SVG/HTML/CSS placeholders. If the request is for an icon, logo, or UI graphic that should match existing repo-native SVG/vector/code assets, prefer editing those directly instead.
8. Augment the prompt based on specificity:
   - If the user's prompt is already specific and detailed, normalize it into a clear spec without adding creative requirements.
   - If the user's prompt is generic, add tasteful augmentation only when it materially improves output quality.
9. Choose `size`, `quality`, `background`, and `outputFormat` from the intended use; leave them at their defaults when nothing calls for a change.
10. Inspect outputs and validate: subject, style, composition, text accuracy, and invariants/avoid items.
11. Iterate with a single targeted change, then re-check.
12. For preview-only work, leave the images where Wevir saved them.
13. For project-bound work, copy the selected artifact into the workspace and update any consuming code or references.
14. For batches or multi-asset requests, persist every requested deliverable final in the workspace unless the user explicitly asked to keep outputs preview-only. Discarded variants do not need to be kept unless requested.
15. Always report the final saved path(s) for any workspace-bound asset(s), plus the final prompt or prompt set and the model used.

## Transparent image requests

- `gpt-image-2` does not support `background: transparent`. If the provider also lists a model that does (for example `gpt-image-1.5`), ask the user before switching to it unless they already named that model; then pass `model`, `background: transparent`, and `outputFormat` `png` or `webp`.
- If no transparency-capable model is available, say so, and offer an image on a flat, uniform background that is easy to cut out instead. Do not claim the result is transparent.
- With Codex's `image_gen`, ask for a genuinely transparent background and preserve its alpha.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail.

Treat this as prompt-shaping guidance, not a closed schema. Use only the lines that help, and add a short extra labeled line when it materially improves clarity.

### Specificity policy

Use the user's prompt specificity to decide how much augmentation is appropriate:

- If the prompt is already specific and detailed, preserve that specificity and only normalize/structure it.
- If the prompt is generic, you may add tasteful augmentation when it will materially improve the result.

Allowed augmentations:
- composition or framing hints
- polish level or intended-use hints
- practical layout guidance
- reasonable scene concreteness that supports the stated request

Not allowed augmentations:
- extra characters or objects that are not implied by the request
- brand names, slogans, palettes, or narrative beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Use-case taxonomy (exact slugs)

Classify each request into one of these buckets and keep the slug consistent across prompts and references.

Generate:
- photorealistic-natural — candid/editorial lifestyle scenes with real texture and natural lighting.
- product-mockup — product/packaging shots, catalog imagery, merch concepts.
- ui-mockup — app/web interface mockups and wireframes; specify the desired fidelity.
- infographic-diagram — diagrams/infographics with structured layout and text.
- scientific-educational — classroom explainers, scientific diagrams, and learning visuals with required labels and accuracy constraints.
- ads-marketing — campaign concepts and ad creatives with audience, brand position, scene, and exact tagline/copy.
- productivity-visual — slide, chart, workflow, and data-heavy business visuals.
- logo-brand — logo/mark exploration, vector-friendly.
- illustration-story — comics, children’s book art, narrative scenes.
- stylized-concept — style-driven concept art, 3D/stylized renders.
- historical-scene — period-accurate/world-knowledge scenes.

Edit:
- text-localization — translate/replace in-image text, preserve layout.
- identity-preserve — try-on, person-in-scene; lock face/body/pose.
- precise-object-edit — remove/replace a specific element (including interior swaps).
- lighting-weather — time-of-day/season/atmosphere changes only.
- background-extraction — transparent background / clean cutout; see "Transparent image requests".
- style-transfer — apply reference style while changing subject/scene.
- compositing — multi-image insert/merge with matched lighting/perspective.
- sketch-to-render — drawing/line art to photoreal render.

## Shared prompt schema

Use the following labeled spec as prompt scaffolding:

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Notes:
- `Asset type` and `Input images` are prompt scaffolding, not tool arguments.
- `Scene/backdrop` refers to the visual setting. It is not the same as the tool's `background` argument, which controls output transparency.
- Execution settings such as size, quality, transparency, masks, and output format go in the tool's arguments, not in the prompt text.

Augmentation rules:
- Keep it short.
- Add only the details needed to improve the prompt materially.
- For edits, explicitly list invariants (`change only X; keep Y unchanged`).
- If any critical detail is missing and blocks success, ask a question; otherwise proceed.

## Examples

### Generation example (hero image)
```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy if needed
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

### Edit example (invariants)
```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```

## Prompting best practices
- Structure prompt as scene/backdrop -> subject -> details -> constraints.
- Include intended use (ad, UI mock, infographic) to set the mode and polish level.
- Use camera/composition language for photorealism.
- Only use SVG/vector stand-ins when the user explicitly asked for vector output or a non-image placeholder.
- Quote exact text and specify typography + placement.
- For tricky words, spell them letter-by-letter and require verbatim rendering.
- For multi-image inputs, reference images by index and describe how they should be used.
- For edits, repeat invariants every iteration to reduce drift.
- Iterate with single-change follow-ups.
- If the prompt is generic, add only the extra detail that will materially help.
- If the prompt is already detailed, normalize it instead of expanding it.

More principles: `references/prompting.md`.
Copy/paste specs: `references/sample-prompts.md`.

## Guidance by asset type
Asset-type templates (website assets, game assets, wireframes, logo) are consolidated in `references/sample-prompts.md`.

## gpt-image-2 guidance

- `gpt-image-2` always uses high fidelity for image inputs; there is no fidelity setting.
- Square images are typically fastest to generate. Use `1024x1024` for fast square drafts.
- If the user asks for 4K-style output, use `3840x2160` for landscape or `2160x3840` for portrait.
- `size` may be `auto` or `WIDTHxHEIGHT` if all constraints hold: max edge `<= 3840px`, both edges multiples of `16px`, long-to-short ratio `<= 3:1`, total pixels between `655,360` and `8,294,400`.

Popular `gpt-image-2` sizes:
- `1024x1024` square
- `1536x1024` landscape
- `1024x1536` portrait
- `2048x2048` 2K square
- `2048x1152` 2K landscape
- `3840x2160` 4K landscape
- `2160x3840` 4K portrait
- `auto`

## Reference map
- `references/prompting.md`: prompting principles.
- `references/sample-prompts.md`: copy/paste prompt recipes.
- `references/image-api.md`: models, sizes, and argument limits for `wevir_image_generate`.
