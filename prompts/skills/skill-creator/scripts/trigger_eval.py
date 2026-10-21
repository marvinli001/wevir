#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Anthropic, PBC.
# Adapted from anthropics/skills, commit dbd4588f1e1033efb41dad4bef2f7947c8993d44,
# skills/skill-creator/scripts/{run_eval,run_loop,improve_description}.py. Those scripts start
# `claude -p` to see whether a description makes Claude Code load the skill. Wevir has no such
# headless mode, so this script keeps their bookkeeping (stratified train/test split, trigger
# rates, the blinded improvement prompt) and leaves the model calls to the agent, which sends each
# selection prompt to its own subagent or Wevir session.
"""Trigger evaluation helpers for skill descriptions.

Subcommands:
    split           Split an eval set into train and held-out test sets, stratified by should_trigger.
    prompts         Write one skill-selection prompt per query (and per run) for subagents to answer.
    score           Turn the subagents' answers into trigger rates and pass/fail per query.
    improve-prompt  Print the prompt for a fresh subagent to propose a better description from the
                    train results only (test results stay hidden to avoid overfitting).

Usage:
    python3 -B scripts/trigger_eval.py split <eval_set.json> --out-dir <dir>
    python3 -B scripts/trigger_eval.py prompts <train.json> --skill-path <skill> --out <prompts.json>
        [--description TEXT] [--others <skills.json>] [--runs 1]
    python3 -B scripts/trigger_eval.py score <prompts.json> --answers <answers.json> [--threshold 0.5]
    python3 -B scripts/trigger_eval.py improve-prompt --skill-path <skill> --results <train-results.json>
        [--history <history.json>]
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
# Runs as a file path or with -m from the skill-creator folder.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.utils import parse_skill_md  # noqa: E402

DESCRIPTION_LIMIT = 1024


def split_eval_set(eval_set: list[dict], holdout: float, seed: int = 42) -> tuple[list[dict], list[dict]]:
    """Split eval set into train and test sets, stratified by should_trigger."""
    rng = random.Random(seed)
    trigger = [e for e in eval_set if e["should_trigger"]]
    no_trigger = [e for e in eval_set if not e["should_trigger"]]
    rng.shuffle(trigger)
    rng.shuffle(no_trigger)
    n_trigger_test = max(1, int(len(trigger) * holdout)) if trigger else 0
    n_no_trigger_test = max(1, int(len(no_trigger) * holdout)) if no_trigger else 0
    test_set = trigger[:n_trigger_test] + no_trigger[:n_no_trigger_test]
    train_set = trigger[n_trigger_test:] + no_trigger[n_no_trigger_test:]
    return train_set, test_set


def selection_prompt(query: str, skills: list[dict]) -> str:
    """The question a subagent answers: which skill, if any, it would open for this request."""
    listing = "\n".join(f"- {s['name']}: {s['description']}" for s in skills)
    return f"""You are an AI agent working in Wevir. Before starting on a request you may open one of the skills below: a folder of instructions you read when it helps with the request. Open one only when the request needs it; requests you can easily handle directly need none.

Available skills:
{listing}

User request:
<request>
{query}
</request>

Do not work on the request and do not run any tools. Reply with only a JSON object naming the skill you would open first, or null for none: {{"skill": "<name>"}} or {{"skill": null}}"""


def build_prompts(eval_set: list[dict], name: str, description: str, others: list[dict], runs: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    distractors = [
        {"name": str(o["name"]), "description": str(o.get("description", ""))}
        for o in others
        if o.get("name") and o["name"] != name
    ]
    items = []
    for index, item in enumerate(eval_set):
        for run in range(runs):
            skills = distractors + [{"name": name, "description": description}]
            # A fresh order per prompt so position does not decide the pick.
            rng.shuffle(skills)
            items.append({
                "id": f"q{index}-r{run}",
                "query": item["query"],
                "should_trigger": bool(item["should_trigger"]),
                "skill_name": name,
                "description": description,
                "prompt": selection_prompt(item["query"], skills),
            })
    return items


def parse_pick(answer) -> str | None:
    """Accept the bare name, null, {"skill": ...}, or a reply that contains that JSON."""
    if answer is None or isinstance(answer, str) and answer.strip().lower() in ("", "null", "none"):
        return None
    if isinstance(answer, dict):
        value = answer.get("skill")
        return None if value is None else str(value).strip()
    text = str(answer)
    match = re.search(r"\{[^{}]*\"skill\"[^{}]*\}", text)
    if match:
        try:
            return parse_pick(json.loads(match.group(0)))
        except json.JSONDecodeError:
            pass
    return text.strip().strip('"').strip("'")


def score(prompts: list[dict], answers: dict, threshold: float) -> dict:
    by_query: dict[str, dict] = {}
    missing = []
    for item in prompts:
        if item["id"] not in answers:
            missing.append(item["id"])
            continue
        entry = by_query.setdefault(item["query"], {
            "query": item["query"],
            "should_trigger": item["should_trigger"],
            "triggers": 0,
            "runs": 0,
        })
        entry["runs"] += 1
        if parse_pick(answers[item["id"]]) == item["skill_name"]:
            entry["triggers"] += 1
    results = []
    for entry in by_query.values():
        rate = entry["triggers"] / entry["runs"]
        passed = rate >= threshold if entry["should_trigger"] else rate < threshold
        results.append({**entry, "trigger_rate": rate, "pass": passed})
    passed = sum(1 for r in results if r["pass"])
    first = prompts[0] if prompts else {}
    return {
        "skill_name": first.get("skill_name", ""),
        "description": first.get("description", ""),
        "results": results,
        "summary": {"total": len(results), "passed": passed, "failed": len(results) - passed},
        **({"missing_answers": missing} if missing else {}),
    }


def improve_prompt(name: str, content: str, results: dict, history: list[dict]) -> str:
    failed = [r for r in results["results"] if r["should_trigger"] and not r["pass"]]
    false = [r for r in results["results"] if not r["should_trigger"] and not r["pass"]]
    summary = results["summary"]
    prompt = f"""You are optimizing the description of a skill called "{name}". A skill is a folder of instructions an AI agent can open. The agent sees only the skill's name and description when deciding whether to open it, so the description decides whether the skill is used. Your goal is a description that makes the agent open the skill for relevant requests and leave it closed for the rest.

Current description:
<current_description>
"{results['description']}"
</current_description>

Current score on the training queries: {summary['passed']}/{summary['total']}

"""
    if failed:
        prompt += "FAILED TO TRIGGER (should have opened the skill but didn't):\n"
        for r in failed:
            prompt += f'  - "{r["query"]}" (triggered {r["triggers"]}/{r["runs"]} times)\n'
        prompt += "\n"
    if false:
        prompt += "FALSE TRIGGERS (opened the skill but shouldn't have):\n"
        for r in false:
            prompt += f'  - "{r["query"]}" (triggered {r["triggers"]}/{r["runs"]} times)\n'
        prompt += "\n"
    if history:
        prompt += "PREVIOUS ATTEMPTS (do NOT repeat these; try something structurally different):\n\n"
        for h in history:
            prompt += f'<attempt train={h.get("train_passed", "?")}/{h.get("train_total", "?")}>\n'
            prompt += f'Description: "{h["description"]}"\n'
            if h.get("note"):
                prompt += f'Note: {h["note"]}\n'
            prompt += "</attempt>\n\n"
    prompt += f"""Skill content (for context on what the skill does):
<skill_content>
{content}
</skill_content>

Write a new description that is more likely to trigger correctly. Generalize from the failures to broader categories of user intent and situations where the skill is or isn't useful; do not produce an ever-growing list of the specific queries above. The description is shown next to every other skill on every request, so keep it to about 100-200 words; the hard limit is {DESCRIPTION_LIMIT} characters.

Tips that work well:
- Phrase it in the imperative: "Use this skill for ..." rather than "This skill does ...".
- Focus on what the user is trying to achieve, not on how the skill works.
- The description competes with other skills for the agent's attention; make it distinctive and immediately recognizable.
- If earlier attempts kept failing, change the sentence structure or wording instead of adding more of the same.

Do not run any tools. Respond with only the new description inside <new_description> tags."""
    return prompt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_split = sub.add_parser("split", help="Stratified train/test split")
    p_split.add_argument("eval_set", type=Path)
    p_split.add_argument("--out-dir", type=Path, required=True)
    p_split.add_argument("--holdout", type=float, default=0.4)
    p_split.add_argument("--seed", type=int, default=42)

    p_prompts = sub.add_parser("prompts", help="Write skill-selection prompts")
    p_prompts.add_argument("eval_set", type=Path)
    p_prompts.add_argument("--skill-path", type=Path, required=True)
    p_prompts.add_argument("--description", default=None, help="Description to test (default: the SKILL.md one)")
    p_prompts.add_argument("--others", type=Path, default=None, help="JSON list of {name, description} for the other skills")
    p_prompts.add_argument("--runs", type=int, default=1, help="Prompts per query")
    p_prompts.add_argument("--seed", type=int, default=42)
    p_prompts.add_argument("--out", type=Path, required=True)

    p_score = sub.add_parser("score", help="Score subagent answers")
    p_score.add_argument("prompts", type=Path)
    p_score.add_argument("--answers", type=Path, required=True, help='JSON object {"<prompt id>": <reply>}')
    p_score.add_argument("--threshold", type=float, default=0.5)

    p_improve = sub.add_parser("improve-prompt", help="Print the description improvement prompt")
    p_improve.add_argument("--skill-path", type=Path, required=True)
    p_improve.add_argument("--results", type=Path, required=True, help="score output for the train set")
    p_improve.add_argument("--history", type=Path, default=None, help="JSON list of earlier attempts")

    args = parser.parse_args()

    if args.command == "split":
        eval_set = json.loads(args.eval_set.read_text())
        train, test = split_eval_set(eval_set, args.holdout, args.seed)
        args.out_dir.mkdir(parents=True, exist_ok=True)
        (args.out_dir / "train.json").write_text(json.dumps(train, indent=2) + "\n")
        (args.out_dir / "test.json").write_text(json.dumps(test, indent=2) + "\n")
        print(f"train: {len(train)} queries, test: {len(test)} queries -> {args.out_dir}")
    elif args.command == "prompts":
        name, original, _ = parse_skill_md(args.skill_path)
        description = args.description or original
        if len(description) > DESCRIPTION_LIMIT:
            print(f"Warning: description is {len(description)} characters (limit {DESCRIPTION_LIMIT})", file=sys.stderr)
        others = json.loads(args.others.read_text()) if args.others else []
        items = build_prompts(json.loads(args.eval_set.read_text()), name, description, others, args.runs, args.seed)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(items, indent=2) + "\n")
        print(f"{len(items)} prompts -> {args.out}")
    elif args.command == "score":
        output = score(json.loads(args.prompts.read_text()), json.loads(args.answers.read_text()), args.threshold)
        print(json.dumps(output, indent=2))
        if output.get("missing_answers"):
            print(f"Warning: {len(output['missing_answers'])} prompts have no answer", file=sys.stderr)
    elif args.command == "improve-prompt":
        name, _, content = parse_skill_md(args.skill_path)
        history = json.loads(args.history.read_text()) if args.history else []
        print(improve_prompt(name, content, json.loads(args.results.read_text()), history))


if __name__ == "__main__":
    main()
