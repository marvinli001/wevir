---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, turn a workflow from the conversation into a skill, edit or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
metadata:
  short-description: Create, test and improve skills
---

<!--
Wevir built-in skill. Adapted from anthropics/skills, commit dbd4588f1e1033efb41dad4bef2f7947c8993d44,
skills/skill-creator/SKILL.md (Apache-2.0, Copyright 2026 Anthropic, PBC; see LICENSE.txt), with notes from the
copy that ships with Claude Code and from Codex's sample skill-creator. Changes: written for any model on Wevir;
test runs, timing, the review viewer, installing and sharing use Wevir's tools; description optimization runs
as subagent selection judgments instead of `claude -p`; the Claude.ai and Cowork sections are folded into
"When tools are missing".
-->

# Skill Creator

A skill for creating new skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Create a few test prompts and run an agent that has the skill on them
- Help the user evaluate the results both qualitatively and quantitatively
  - While the runs happen in the background, draft some quantitative evals if there aren't any (if there are some, you can either use them as is or modify them if something needs to change). Then explain them to the user (or if they already existed, explain the ones that already exist)
  - Use `eval-viewer/generate_review.py` to show the user the results, together with the quantitative metrics
- Rewrite the skill based on the user's feedback (and on any glaring flaws the quantitative benchmarks reveal)
- Repeat until you're satisfied
- Expand the test set and try again at larger scale

Your job when using this skill is to figure out where the user is in this process and then jump in and help them progress through these stages. Maybe they say "I want to make a skill for X": help narrow down what they mean, write a draft, write the test cases, figure out how they want to evaluate, run all the prompts, and repeat. Maybe they already have a draft: go straight to the eval/iterate part of the loop.

Always be flexible. If the user says "I don't need to run a bunch of evaluations, just vibe with me", do that instead.

After the skill is done (the order is flexible), you can also optimize the description so the skill triggers when it should.

## Working in Wevir

- **This folder.** `<skill-creator>` below means the folder that holds this SKILL.md. It is part of the Wevir installation and may be read-only, so never write into it: run its scripts by path and write every output into the user's folders. Run the Python scripts with `python3 -B` (no bytecode next to them); they need only the standard library and work with Python 3.9 or later.
- **Where the skill lives.** Unless the user names a place, draft the new skill as `<session folder>/<skill-name>/` and keep test results in `<session folder>/<skill-name>-workspace/`. Tell the user where they are. A skill that belongs to a repository can go in its `.agents/skills/<skill-name>/` instead. Offer to delete the workspace once the skill is finished.
- **Installing.** `wevir_skill_install` with the skill folder installs it into Wevir for every session (the user approves it). See "Install and share" at the end.
- **Which engines read skills.** Wevir hands its skills to sessions on the Codex engine (the default). Other engines discover skills their own way; for example Claude reads `~/.claude/skills/` and a project's `.claude/skills/`. Keep that in mind when the user asks why a skill does not show up somewhere.
- **The model is not fixed.** Wevir runs many providers and models. Write skills for a capable model in general, not for one vendor's quirks, unless the user targets a specific model.

## Communicating with the user

People across a wide range of familiarity with coding jargon use the skill creator. Some have never opened a terminal before; most are fairly computer-literate. Pay attention to context cues to understand how to phrase your communication. In the default case:

- "evaluation" and "benchmark" are borderline, but OK
- for "JSON" and "assertion", wait for serious cues that the user knows these terms before using them without explanation

It's OK to briefly explain terms if you're in doubt.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first: the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step. Earlier sessions can hold the workflow too: `wevir_session_search` and `wevir_session_read` find and read them.

1. What should this skill enable the agent to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases to verify the skill works? Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflow steps) benefit from test cases. Skills with subjective outputs (writing style, art) often don't need them. Suggest the appropriate default based on the skill type, but let the user decide.

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out.

Check what is available for research (searching docs, finding similar skills with `wevir_plugins_list`, looking up best practices). Research in parallel with subagents if you have them, otherwise inline. Come prepared with context to reduce the burden on the user.

### Write the SKILL.md

Based on the user interview, fill in these components:

- **name**: Skill identifier: lowercase letters, digits and hyphens, at most 64 characters; name the folder the same. Wevir refuses to install a skill whose name is already taken, so check `wevir_plugins_list` first.
- **description**: When to trigger, what it does. This is the primary triggering mechanism: include both what the skill does AND specific contexts for when to use it. All "when to use" info goes here, not in the body. At most 1024 characters. Agents tend to "undertrigger" skills, not using them when they'd be useful. To combat this, make the description a little bit "pushy". So instead of "How to build a simple fast dashboard to display internal sales data.", you might write "How to build a simple fast dashboard to display internal sales data. Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don't explicitly ask for a 'dashboard.'"
- **metadata.short-description**: A few words for Wevir's skill list (optional).
- **compatibility**: Required tools, dependencies (optional, rarely needed)
- **the rest of the skill :)**

### Skill Writing Guide

#### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    ├── assets/     - Files used in output (templates, icons, fonts)
    └── agents/openai.yaml - Codex display name, icon and invocation policy (optional)
```

Keep exactly one SKILL.md per skill folder: Wevir stops looking inside a folder once it finds one, so a nested SKILL.md never loads. Don't add a README, changelog or installation guide unless a task needs it.

#### Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever the skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)

These word counts are approximate and you can go longer if needed.

**Key patterns:**
- Keep SKILL.md under 500 lines; if you're approaching this limit, add an additional layer of hierarchy along with clear pointers about where the model using the skill should go next.
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents

**Domain organization**: When a skill supports multiple domains/frameworks, organize by variant:
```
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```
The agent reads only the relevant reference file.

#### Principle of Lack of Surprise

Skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. Things like a "roleplay as an XYZ" are OK though.

A skill also shouldn't widen what the user agreed to: approval for a task doesn't extend its scope, and a skill that changes things outside the conversation (sends, deletes, publishes, spends) should ask right before doing so rather than assume permission.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats** - You can do it like this:
```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern** - It's useful to include examples. You can format them like this (but if "Input" and "Output" are in the examples you might want to deviate a little):
```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing Style

Try to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Assume the model is already capable: include what changes its decisions, not generic advice. Start by writing a draft and then look at it with fresh eyes and improve it.

### Test Cases

After writing the skill draft, come up with 2-3 realistic test prompts — the kind of thing a real user would actually say. Share them with the user: [you don't have to use this exact language] "Here are a few test cases I'd like to try. Do these look right, or do you want to add more?" Then run them.

Save test cases to `evals/evals.json`. Don't write assertions yet — just the prompts. You'll draft assertions in the next step while the runs are in progress.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

See `references/schemas.md` for the full schema (including the `assertions` field, which you'll add later).

Validate the draft whenever you change it:

```bash
python3 -B <skill-creator>/scripts/quick_validate.py <path/to/skill>
```

## Running and evaluating test cases

This section is one continuous sequence — don't stop partway through.

Put results in `<skill-name>-workspace/` as a sibling to the skill directory. Within the workspace, organize results by iteration (`iteration-1/`, `iteration-2/`, etc.) and within that, each test case gets a directory (`eval-0/`, `eval-1/`, etc.). Don't create all of this upfront — just create directories as you go.

### Step 1: Start all runs (with-skill AND baseline) at once

For each test case, start two independent runs at the same time — one with the skill, one without. Don't start the with-skill runs first and come back for baselines later; launch everything at once so it all finishes around the same time.

Each run needs its own fresh context, so it can't be you. Use your engine's subagent tool if you have one. Otherwise, or when the user wants to open and watch each run, use `wevir_session_create` (one session per run, `title` like `eval-0 with_skill`; its answer comes back to you as a message when it finishes, so end your turn instead of polling). Sessions you open show up in the user's sidebar; archive them with `wevir_session_archive` once the user has reviewed the iteration.

**With-skill run:**

```
Execute this task:
- Skill path: <path-to-skill> (read its SKILL.md first and follow it; use only this copy of the skill)
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
- When done, write a short account of what you did, step by step, to <workspace>/iteration-<N>/eval-<ID>/with_skill/transcript.md
```

**Baseline run** (same prompt, but the baseline depends on context):
- **Creating a new skill**: no skill at all. Same prompt, no skill path, save to `without_skill/outputs/`.
- **Improving an existing skill**: the old version. Before editing, snapshot the skill (`cp -r <skill-path> <workspace>/skill-snapshot/`), then point the baseline run at the snapshot. Save to `old_skill/outputs/`.

An installed skill with the same name is visible to every Codex session, so a "without skill" run may still pick it up. When improving an installed skill, mention that in the baseline brief ("do not use any installed skill named <name>") and check the run's transcript.

Write an `eval_metadata.json` for each test case (assertions can be empty for now). Give each eval a descriptive name based on what it's testing — not just "eval-0". Use this name for the directory too. If this iteration uses new or modified eval prompts, create these files for each new eval directory — don't assume they carry over from previous iterations.

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

### Step 2: While runs are in progress, draft assertions

Don't just wait for the runs to finish — use this time productively. Draft quantitative assertions for each test case and explain them to the user. If assertions already exist in `evals/evals.json`, review them and explain what they check.

Good assertions are objectively verifiable and have descriptive names — they should read clearly in the benchmark viewer so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Update the `eval_metadata.json` files and `evals/evals.json` with the assertions once drafted. Also explain to the user what they'll see in the viewer — both the qualitative outputs and the quantitative benchmark.

### Step 3: As runs complete, capture timing data

Save timing for each run to `timing.json` in its run directory as soon as it finishes:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

For a `wevir_session_create` run, call `wevir_session_wait` on it: `lastTurn.durationMs` is the run's duration and `totalTokens` (when the engine reports it) its token count. For other subagents, use what their result reports; if it reports nothing, note the start and end time yourself and leave `total_tokens` out. Record it right away; it is hard to recover later. If a run didn't write its transcript, save its conversation (`wevir_session_read`) as `transcript.md`.

### Step 4: Grade, aggregate, and launch the viewer

Once all runs are done:

1. **Grade each run** — run a grader subagent (or grade inline) that reads `<skill-creator>/agents/grader.md` and evaluates each assertion against the outputs. Save results to `grading.json` in each run directory. The grading.json expectations array must use the fields `text`, `passed`, and `evidence` (not `name`/`met`/`details` or other variants) — the viewer depends on these exact field names. For assertions that can be checked programmatically, write and run a script rather than eyeballing it — scripts are faster, more reliable, and can be reused across iterations.

2. **Aggregate into benchmark**:
   ```bash
   python3 -B <skill-creator>/scripts/aggregate_benchmark.py <workspace>/iteration-N --skill-name <name>
   ```
   This produces `benchmark.json` and `benchmark.md` with pass_rate, time, and tokens for each configuration, with mean ± stddev and the delta. If generating benchmark.json manually, see `references/schemas.md` for the exact schema the viewer expects. Put each with_skill version before its baseline counterpart.

3. **Do an analyst pass** — read the benchmark data and surface patterns the aggregate stats might hide. See `agents/analyzer.md` (the "Analyzing Benchmark Results" section) for what to look for — things like assertions that always pass regardless of skill (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs.

4. **Launch the viewer** with both qualitative outputs and quantitative data. Start it in the background with `wevir_process_start`:
   ```bash
   python3 -B <skill-creator>/eval-viewer/generate_review.py <workspace>/iteration-N \
     --skill-name "my-skill" --benchmark <workspace>/iteration-N/benchmark.json --no-browser
   ```
   with `waitFor: "URL:"`, so the call returns once it prints its address. For iteration 2+, also pass `--previous-workspace <workspace>/iteration-<N-1>`. Then open the printed `http://127.0.0.1:<port>` with `wevir_show` (`kind: "browser"`), which puts it in the Wevir browser pane next to the conversation.

   Without background processes, or when the user prefers a file, use `--static <workspace>/iteration-N/review.html` to write a standalone page and hand it over with `wevir_share_file`. Its "Submit All Reviews" button then downloads `feedback.json` instead of saving it; ask the user to put it in the workspace or paste it.

   Use generate_review.py to create the viewer; there's no need to write custom HTML. Generate it *before* you evaluate the outputs yourself: get the results in front of the human as soon as possible.

5. **Tell the user** something like: "The results are open in the Wevir browser. There are two tabs — 'Outputs' lets you click through each test case and leave feedback, 'Benchmark' shows the quantitative comparison. When you're done, click Submit All Reviews and let me know."

### What the user sees in the viewer

The "Outputs" tab shows one test case at a time:
- **Prompt**: the task that was given
- **Output**: the files the skill produced, rendered inline where possible
- **Previous Output** (iteration 2+): collapsed section showing last iteration's output
- **Formal Grades** (if grading was run): collapsed section showing assertion pass/fail
- **Feedback**: a textbox that auto-saves as they type
- **Previous Feedback** (iteration 2+): their comments from last time, shown below the textbox

The "Benchmark" tab shows the stats summary: pass rates, timing, and token usage for each configuration, with per-eval breakdowns and analyst observations.

Navigation is via prev/next buttons or arrow keys. When done, they click "Submit All Reviews" which saves all feedback to `feedback.json` in the workspace.

### Step 5: Read the feedback

When the user tells you they're done, read `feedback.json`:

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

Empty feedback means the user thought it was fine. Focus your improvements on the test cases where the user had specific complaints.

Stop the viewer when you're done with it (`wevir_process_kill`).

---

## Improving the skill

This is the heart of the loop. You've run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.

### How to think about improvements

1. **Generalize from the feedback.** We're trying to create skills that can be used a million times across many different prompts. Here you and the user iterate on only a few examples over and over again because it helps move faster: the user knows these examples in and out and can quickly assess new outputs. But if the skill works only for those examples, it's useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there's some stubborn issue, try branching out and using different metaphors, or recommending different patterns of working. It's relatively cheap to try and maybe you'll land on something great.

2. **Keep the prompt lean.** Remove things that aren't pulling their weight. Read the transcripts, not just the final outputs — if the skill makes the model waste time on unproductive things, try getting rid of the parts of the skill that cause it and see what happens.

3. **Explain the why.** Try hard to explain the **why** behind everything you ask the model to do. Today's models are *smart*. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the user's feedback is terse or frustrated, try to understand the task, why the user wrote what they wrote, and what they actually wrote, then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach.

4. **Look for repeated work across test cases.** Read the transcripts from the test runs and notice if the runs all independently wrote similar helper scripts or took the same multi-step approach to something. If all 3 test cases resulted in writing a `create_docx.py` or a `build_chart.py`, that's a strong signal the skill should bundle that script. Write it once, put it in `scripts/`, and tell the skill to use it. This saves every future invocation from reinventing the wheel.

Take your time and really mull things over: write a draft revision, then look at it anew and make improvements. Really do your best to get into the head of the user and understand what they want and need.

### The iteration loop

After improving the skill:

1. Apply your improvements to the skill
2. Rerun all test cases into a new `iteration-<N+1>/` directory, including baseline runs. If you're creating a new skill, the baseline is always `without_skill` (no skill) — that stays the same across iterations. If you're improving an existing skill, use your judgment on what makes sense as the baseline: the original version the user came in with, or the previous iteration.
3. Launch the viewer with `--previous-workspace` pointing at the previous iteration
4. Wait for the user to review and tell you they're done
5. Read the new feedback, improve again, repeat

Keep going until:
- The user says they're happy
- The feedback is all empty (everything looks good)
- You're not making meaningful progress

---

## Advanced: Blind comparison

For situations where you want a more rigorous comparison between two versions of a skill (e.g., the user asks "is the new version actually better?"), there's a blind comparison system. Read `agents/comparator.md` and `agents/analyzer.md` for the details. The basic idea is: give two outputs to an independent agent without telling it which is which, and let it judge quality. Then analyze why the winner won.

This is optional, requires subagents, and most users won't need it. The human review loop is usually sufficient.

---

## Description Optimization

The description field in SKILL.md frontmatter is the primary mechanism that determines whether an agent opens a skill. After creating or improving a skill, offer to optimize the description for better triggering accuracy. Save this for when the skill itself is in good shape and the user agrees.

### Step 1: Generate trigger eval queries

Create 20 eval queries — a mix of should-trigger and should-not-trigger. Save as JSON in the workspace:

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

The queries must be realistic and something a Wevir user would actually type. Not abstract requests, but requests that are concrete and specific and have a good amount of detail. For instance, file paths, personal context about the user's job or situation, column names and values, company names, URLs. A little bit of backstory. Some might be in lowercase or contain abbreviations or typos or casual speech. Use a mix of different lengths, and focus on edge cases rather than making them clear-cut (the user will get a chance to sign off on them). Write them in the language the user works in.

Bad: `"Format this data"`, `"Extract text from PDF"`, `"Create a chart"`

Good: `"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`

For the **should-trigger** queries (8-10), think about coverage. You want different phrasings of the same intent — some formal, some casual. Include cases where the user doesn't explicitly name the skill or file type but clearly needs it. Throw in some uncommon use cases and cases where this skill competes with another but should win.

For the **should-not-trigger** queries (8-10), the most valuable ones are the near-misses — queries that share keywords or concepts with the skill but actually need something different. Think adjacent domains, ambiguous phrasing where a naive keyword match would trigger but shouldn't, and cases where the query touches on something the skill does but in a context where another tool is more appropriate.

The key thing to avoid: don't make should-not-trigger queries obviously irrelevant. "Write a fibonacci function" as a negative test for a PDF skill is too easy — it doesn't test anything. The negative cases should be genuinely tricky.

### Step 2: Review with user

Serve the eval set for the user to edit, in the background with `wevir_process_start` (`waitFor: "URL:"`):

```bash
python3 -B <skill-creator>/scripts/review_trigger_evals.py <workspace>/trigger-evals.json \
  --skill-path <path-to-skill> --output <workspace>/trigger-evals.reviewed.json
```

Open the printed URL with `wevir_show` (`kind: "browser"`). The user can edit queries, toggle should-trigger, add or remove entries, then click "Export Eval Set", which writes `trigger-evals.reviewed.json`. Stop the server afterwards. Without background processes, show the list in the conversation and ask for edits instead.

This step matters — bad eval queries lead to bad descriptions.

### Step 3: Run the optimization loop

Wevir has no headless mode that reports whether a session opened a skill, so each trigger check is a selection judgment: a fresh subagent sees the skill list (the candidate description among the user's other skills) and one query, and names the skill it would open, without doing the task. This is close to how the description is used, not identical: a real session also weighs its project, tools and conversation. Tell the user this before you start, and that the loop takes a while.

1. **Split once**, holding out 40% for testing so the final pick isn't overfitted:
   ```bash
   python3 -B <skill-creator>/scripts/trigger_eval.py split <workspace>/trigger-evals.reviewed.json --out-dir <workspace>/trigger
   ```
2. **List the other skills** as distractors: write the enabled skills from `wevir_plugins_list` (name and description only) to `<workspace>/trigger/others.json`.
3. **Score a description** on a set (train, and test for each candidate). Generate the prompts, give each one to its own fresh subagent with the instruction to reply only with the JSON it asks for, collect the replies into a JSON object keyed by prompt `id`, and score them:
   ```bash
   python3 -B <skill-creator>/scripts/trigger_eval.py prompts <workspace>/trigger/train.json \
     --skill-path <path-to-skill> --others <workspace>/trigger/others.json \
     --out <workspace>/trigger/iter-1/train-prompts.json [--description "<candidate>"] [--runs 3]
   python3 -B <skill-creator>/scripts/trigger_eval.py score <workspace>/trigger/iter-1/train-prompts.json \
     --answers <workspace>/trigger/iter-1/train-answers.json > <workspace>/trigger/iter-1/train-results.json
   ```
   Use the same provider and model as this session for the subagents, so the check matches what the user actually experiences. `--runs 3` gives steadier trigger rates at three times the cost; start with 1 and rerun only the queries that flip.
4. **Propose a better description** from the train results only. Print the improvement prompt and give it to a fresh subagent (so it never sees the test results), then take the text in its `<new_description>` tags:
   ```bash
   python3 -B <skill-creator>/scripts/trigger_eval.py improve-prompt --skill-path <path-to-skill> \
     --results <workspace>/trigger/iter-1/train-results.json --history <workspace>/trigger/history.json
   ```
   Keep `history.json` as a list of `{"description", "train_passed", "train_total", "test_passed", "test_total"}`, one entry per attempt; `improve-prompt` shows earlier attempts' train scores only.
5. **Repeat** steps 3-4 up to 5 times, scoring each candidate on both train and test. Stop early when everything passes.

Pick the best description by **test** score, not train score.

### How skill triggering works

Understanding the triggering mechanism helps design better eval queries. Skills appear in the agent's list of available skills with their name + description, and the agent decides whether to open a skill based on that description. The agent opens skills mainly for tasks it can't easily handle on its own — simple, one-step queries like "read this PDF" may not trigger a skill even if the description matches perfectly, because the agent can handle them directly with basic tools. Complex, multi-step, or specialized queries reliably trigger skills when the description matches.

This means your eval queries should be substantive enough that the agent would actually benefit from consulting a skill. Simple queries like "read file X" are poor test cases — they won't trigger skills regardless of description quality.

### Step 4: Apply the result

Update the skill's SKILL.md frontmatter with the best description. Show the user before/after and report the train and test scores. Once the skill is installed, try one or two should-trigger queries in a new session to confirm it really opens the skill there.

---

## Install and share

When the user is happy with the skill:

- **Install it into Wevir**: `wevir_skill_install` with the path of the skill folder (inside this session's folder; the user approves the install). It becomes available to every session; Codex picks it up from the next turn or the next new session.
- **Update an installed skill**: keep the original name (`research-helper`, not `research-helper-v2`). Wevir won't install over an existing skill, so ask the user to remove the old one in Plugins first (built-in skills can only be turned off there), then install the new version. Skills under `~/.agents/skills/` or a project's `.agents/skills/` can be edited in place instead; those are off until the user turns them on in Plugins.
- **Share it as a file**: package it and hand the ZIP over with `wevir_share_file`. Anyone can install the ZIP from Wevir's Plugins page.
  ```bash
  python3 -B <skill-creator>/scripts/package_skill.py <path/to/skill-folder> <session folder>
  ```
  The package leaves out `evals/` at the skill root, `__pycache__`, `node_modules` and `.git`.

To edit a skill whose folder you can't write to (a built-in or installed one), copy it into the session folder, edit the copy, and install it as above.

---

## When tools are missing

The workflow is the same everywhere (draft → test → review → improve → repeat), but some steps need tools a session may not have:

- **No subagents or Wevir sessions**: run each test case yourself, one at a time: read the skill's SKILL.md, then follow it to do the test prompt. This is less rigorous (you wrote the skill and have full context), but it's a useful sanity check, and the human review compensates. Skip the baseline runs, the quantitative benchmark, blind comparison and description optimization.
- **No background processes or browser**: generate the viewer with `--static`, share the HTML with `wevir_share_file` or tell the user its path, and read `feedback.json` once they put it in the workspace. Or present each test case's prompt and output in the conversation and ask for feedback inline.
- **No Wevir tools at all** (another client): leave the finished skill folder where the user asked, and package it with `package_skill.py` if they want a file.

---

## Reference files

The agents/ directory contains instructions for specialized subagents. Read them when you need to run the relevant subagent.

- `agents/grader.md` — How to evaluate assertions against outputs
- `agents/comparator.md` — How to do blind A/B comparison between two outputs
- `agents/analyzer.md` — How to analyze why one version beat another

The references/ directory has additional documentation:
- `references/schemas.md` — JSON structures for evals.json, grading.json, etc.

---

Repeating one more time the core loop here for emphasis:

- Figure out what the skill is about
- Draft or edit the skill
- Run an agent that has the skill on test prompts
- With the user, evaluate the outputs:
  - Create benchmark.json and run `eval-viewer/generate_review.py` to help the user review them
  - Run quantitative evals
- Repeat until you and the user are satisfied
- Install the skill (or package it) for the user.

If you keep a task list, add these steps to it so you don't forget any — especially "run `eval-viewer/generate_review.py` so the user can review the test cases" before you revise the skill yourself.

Good luck!
