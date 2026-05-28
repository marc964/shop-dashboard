"""
Generate Claude-written "what's left to do" summaries for each open Monthly
Goal task on the focus-checkout slides.

Context per task: ClickUp comments (chronological) and checklist items. The
task description and parent task are intentionally ignored — descriptions are
boilerplate templates and parent tasks (Subsystems) carry only drive links.

Per-task content is hashed; the result is cached in data/focus-summary-cache.json
so unchanged tasks don't re-summarize on every pipeline run.
"""

import json
import os
from datetime import datetime
from pathlib import Path

try:
    import anthropic
except ImportError:
    anthropic = None


MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """You are writing one-glance status notes for open Monthly Goal tasks at Moment Motor Co., an electric-vehicle restoration shop. The notes appear on a TV in the shop — readable in a second from across the room.

You will receive a task title, a chronological log of comments (oldest first), and any checklist items. Skim ALL of it, then output ONE short line — at most 15 words — capturing the single most important thing: the current blocker, the next concrete step, or where the work was left off. If everything is moving and there's no blocker, name the most recent action and what comes next.

Rules:
- One sentence. Hard max 15 words.
- No preamble. No "the task" or "currently". Just the state.
- Be concrete: name parts, errors, dates, or people only when they're the point.
- Don't restate the task title. Don't name the assignee.
- If comments give no real signal, output exactly: "No recent activity logged."
- Plain prose. No bullets, no markdown, no emoji."""


def _format_task_for_prompt(task, owner, vehicle_label):
    lines = []
    lines.append(f"Car: {owner} — {vehicle_label}")
    lines.append(f"Task: {task.get('name', '')}")
    if task.get("status"):
        lines.append(f"ClickUp status: {task['status']}")
    lines.append("")

    checklists = task.get("checklist_items") or []
    if checklists:
        lines.append("Checklist items:")
        for it in checklists:
            mark = "[x]" if it.get("resolved") else "[ ]"
            cl = it.get("checklist") or ""
            cl_prefix = f"({cl}) " if cl else ""
            lines.append(f"  {mark} {cl_prefix}{it.get('name', '')}")
        lines.append("")

    comments = task.get("comments") or []
    if comments:
        lines.append(f"Comments (oldest first, {len(comments)} total):")
        for c in comments:
            date = c.get("date") or "?"
            author = c.get("author") or "?"
            text = (c.get("text") or "").strip()
            text = text.replace("\r", "")
            lines.append(f"[{date}] {author}:")
            for tl in text.split("\n"):
                lines.append(f"  {tl}")
            lines.append("")
    else:
        lines.append("Comments: none")

    return "\n".join(lines)


def _vehicle_label(vehicle):
    if not vehicle:
        return ""
    parts = []
    for k in ("year", "make", "model"):
        v = vehicle.get(k)
        if v:
            parts.append(str(v))
    return " ".join(parts)


def _call_claude(client, user_content):
    resp = client.messages.create(
        model=MODEL,
        max_tokens=80,
        system=[{
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_content}],
    )
    parts = []
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            parts.append(block.text)
    return "".join(parts).strip()


def _load_cache(cache_path):
    if not cache_path.exists():
        return {}
    try:
        return json.loads(cache_path.read_text())
    except Exception:
        return {}


def _save_cache(cache_path, cache):
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, indent=2, ensure_ascii=False))


def apply_summaries(focus_data, cache_path=None):
    """Attach a 'summary' field to each task in focus_data['projects'][*]['assignees'][*]['tasks'].

    Skips tasks with no comments and no checklist items (summary set to None).
    Uses content_hash to cache results between runs.
    """
    if cache_path is None:
        cache_path = Path("data/focus-summary-cache.json")
    else:
        cache_path = Path(cache_path)

    if anthropic is None:
        print("  WARNING: anthropic SDK not installed; skipping summaries")
        return focus_data

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("  WARNING: ANTHROPIC_API_KEY not set; skipping summaries")
        return focus_data

    cache = _load_cache(cache_path)
    client = anthropic.Anthropic()

    # Track seen tasks across the JSON (same task can appear under multiple assignees)
    seen = {}
    pending = []
    for project in focus_data.get("projects", []):
        owner = project.get("owner")
        vehicle = project.get("vehicle")
        label = _vehicle_label(vehicle)
        for assignee in project.get("assignees", []):
            for task in assignee.get("tasks", []):
                tid = task.get("id")
                if not tid:
                    continue
                if tid in seen:
                    task["summary"] = seen[tid]
                    continue
                has_comments = bool(task.get("comments"))
                has_checklist = bool(task.get("checklist_items"))
                if not has_comments and not has_checklist:
                    task["summary"] = None
                    seen[tid] = None
                    continue
                content_hash = task.get("content_hash")
                cached = cache.get(tid)
                if cached and cached.get("hash") == content_hash:
                    task["summary"] = cached.get("summary")
                    seen[tid] = cached.get("summary")
                    continue
                pending.append((tid, task, owner, label))

    if not pending:
        print(f"  All {len(seen)} task summaries served from cache")
        return focus_data

    print(f"  Generating {len(pending)} new task summaries via Claude...")
    for tid, task, owner, label in pending:
        try:
            user_content = _format_task_for_prompt(task, owner, label)
            summary = _call_claude(client, user_content)
        except Exception as e:
            print(f"    Claude call failed for {tid}: {e}")
            summary = None
        task["summary"] = summary
        seen[tid] = summary
        if summary:
            cache[tid] = {
                "hash": task.get("content_hash"),
                "summary": summary,
                "summarized_at": datetime.utcnow().isoformat() + "Z",
            }
            print(f"    {tid}: {summary[:80]}...")

    # Drop stale cache entries (tasks no longer in the focus set)
    active_ids = set(seen.keys())
    cache = {tid: entry for tid, entry in cache.items() if tid in active_ids}

    _save_cache(cache_path, cache)
    print(f"  Wrote cache to {cache_path} ({len(cache)} entries)")
    return focus_data
