#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TASK_KEYS = [
    "tasks",
    "task_list",
    "tasklist",
    "workboard",
    "kanban",
    "backlog",
    "todos",
    "items",
]

TASK_FILE_KEYWORDS = [
    "tasks",
    "task",
    "task-list",
    "tasklist",
    "kanban",
    "workboard",
    "backlog",
    "todo",
]

STATUS_ALIASES: dict[str, str] = {
    "todo": "todo",
    "open": "todo",
    "pending": "todo",
    "queued": "todo",
    "queue": "todo",
    "backlog": "todo",
    "not_started": "todo",
    "not-started": "todo",
    "in_progress": "in_progress",
    "in-progress": "in_progress",
    "inprogress": "in_progress",
    "doing": "in_progress",
    "active": "in_progress",
    "wip": "in_progress",
    "running": "in_progress",
    "done": "done",
    "completed": "done",
    "complete": "done",
    "closed": "done",
    "resolved": "done",
    "blocked": "blocked",
    "waiting": "blocked",
    "on_hold": "blocked",
    "on-hold": "blocked",
}

PRIORITY_ALIASES: dict[str, str] = {
    "high": "high",
    "urgent": "high",
    "critical": "high",
    "p0": "high",
    "p1": "high",
    "1": "high",
    "medium": "medium",
    "med": "medium",
    "normal": "medium",
    "default": "medium",
    "p2": "medium",
    "2": "medium",
    "low": "low",
    "minor": "low",
    "p3": "low",
    "p4": "low",
    "3": "low",
    "4": "low",
}

PRIORITY_RANK = {"low": 1, "medium": 2, "high": 3}
EXCLUDED_DIRS = {
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    ".cache",
}


class TaskqError(Exception):
    pass


@dataclass
class Task:
    index: int
    id: str | None
    ref: str
    title: str
    status: str
    priority: str
    depends_on: list[str]
    content_hash: str
    source_locator: dict[str, Any]
    raw: dict[str, Any]

    def as_public(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "id": self.id,
            "ref": self.ref,
            "title": self.title,
            "status": self.status,
            "priority": self.priority,
            "depends_on": self.depends_on,
            "content_hash": self.content_hash,
            "source_locator": self.source_locator,
        }


@dataclass
class Board:
    path: Path
    fmt: str
    tasks: list[Task]
    data: Any
    root_kind: str
    root_key: str | None = None
    markdown_lines: list[str] | None = None

    def meta(self) -> dict[str, Any]:
        return {"path": str(self.path), "format": self.fmt}


def fail(msg: str) -> None:
    raise TaskqError(msg)


def normalize_status(value: Any, default: str = "todo") -> str:
    if value is None:
        return default
    text = str(value).strip().lower().replace(" ", "_")
    if text in STATUS_ALIASES:
        return STATUS_ALIASES[text]
    if text in {"true", "false"}:
        return "done" if text == "true" else "todo"
    return default


def normalize_priority(value: Any, default: str = "medium") -> str:
    if value is None:
        return default
    text = str(value).strip().lower().replace(" ", "_")
    return PRIORITY_ALIASES.get(text, default)


def split_depends(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        deps = [str(x).strip() for x in value if str(x).strip()]
        return dedupe_keep_order(deps)
    text = str(value).strip()
    if not text:
        return []
    if text.startswith("[") and text.endswith("]"):
        body = text[1:-1]
        items = [x.strip().strip("'\"") for x in body.split(",")]
        return dedupe_keep_order([x for x in items if x])
    parts = re.split(r"[,\s;]+", text)
    return dedupe_keep_order([p for p in parts if p])


def dedupe_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def first_present(obj: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in obj and obj[key] not in ("", None):
            return obj[key]
    return None


def compute_hash(task_seed: dict[str, Any]) -> str:
    blob = json.dumps(task_seed, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def make_ref(task_id: str | None, index: int, content_hash: str) -> str:
    if task_id:
        return task_id
    return f"idx:{index}:h:{content_hash[:12]}"


def to_task(idx: int, obj: dict[str, Any], extra_locator: dict[str, Any] | None = None) -> Task:
    task_id_raw = first_present(obj, ["id", "task_id", "taskId", "key"])
    task_id = str(task_id_raw).strip() if task_id_raw is not None and str(task_id_raw).strip() else None
    title_raw = first_present(obj, ["title", "name", "summary", "task", "description"])
    title = str(title_raw).strip() if title_raw is not None and str(title_raw).strip() else f"Task {idx + 1}"

    status_raw = first_present(obj, ["status", "state", "column", "stage"])
    if status_raw is None and "done" in obj:
        status_raw = bool(obj.get("done"))
    status = normalize_status(status_raw, default="todo")

    priority_raw = first_present(obj, ["priority", "prio", "severity", "rank", "importance"])
    priority = normalize_priority(priority_raw, default="medium")

    depends_raw = first_present(
        obj,
        [
            "depends_on",
            "dependsOn",
            "dependencies",
            "blocked_by",
            "blockedBy",
            "requires",
            "prereqs",
            "prerequisites",
            "gateblocking",
        ],
    )
    depends_on = split_depends(depends_raw)

    content_hash = compute_hash(
        {
            "id": task_id,
            "title": title,
            "status": status,
            "priority": priority,
            "depends_on": depends_on,
        }
    )
    ref = make_ref(task_id, idx, content_hash)

    locator = {"index": idx, "hash": content_hash}
    if extra_locator:
        locator.update(extra_locator)

    return Task(
        index=idx,
        id=task_id,
        ref=ref,
        title=title,
        status=status,
        priority=priority,
        depends_on=depends_on,
        content_hash=content_hash,
        source_locator=locator,
        raw=obj,
    )


def discover_board(cwd: Path, explicit_path: str | None) -> Path:
    env_override = os.environ.get("TASKQ_FILE")
    if explicit_path:
        candidate = (cwd / explicit_path).resolve() if not os.path.isabs(explicit_path) else Path(explicit_path)
        if not candidate.exists():
            fail(f"board file not found: {candidate}")
        return candidate
    if env_override:
        candidate = (cwd / env_override).resolve() if not os.path.isabs(env_override) else Path(env_override)
        if not candidate.exists():
            fail(f"board file not found from TASKQ_FILE: {candidate}")
        return candidate

    scan_roots = [
        (cwd, 2, 25),
        (cwd / "docs", 3, 12),
        (cwd / ".github", 3, 10),
        (cwd / "planning", 3, 8),
    ]
    candidates: list[tuple[int, Path]] = []
    seen: set[Path] = set()

    for root, depth_limit, base_bonus in scan_roots:
        if not root.exists() or not root.is_dir():
            continue
        for path in iter_candidate_files(root, depth_limit):
            if path in seen:
                continue
            seen.add(path)
            score = candidate_score(cwd, path) + base_bonus
            candidates.append((score, path))

    if not candidates:
        fail("no task board found. expected keywords like task/task-list/kanban/workboard/todo in JSON/YAML/Markdown file names")

    candidates.sort(key=lambda x: (-x[0], str(x[1])))
    return candidates[0][1]


def iter_candidate_files(root: Path, depth_limit: int):
    root = root.resolve()
    for current, dirs, files in os.walk(root):
        cur_path = Path(current)
        rel_parts = cur_path.relative_to(root).parts
        if len(rel_parts) > depth_limit:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        for name in files:
            lower = name.lower()
            if not lower.endswith((".json", ".yaml", ".yml", ".md")):
                continue
            if not any(keyword in lower for keyword in TASK_FILE_KEYWORDS):
                continue
            yield (cur_path / name).resolve()


def candidate_score(cwd: Path, path: Path) -> int:
    name = path.name.lower()
    depth = len(path.relative_to(cwd).parts)
    score = 0
    if re.fullmatch(r"tasks?\.(json|ya?ml|md)", name):
        score += 220
    if "task-list" in name or "tasklist" in name:
        score += 150
    if "tasks" in name:
        score += 130
    elif "task" in name:
        score += 110
    if "kanban" in name or "workboard" in name:
        score += 100
    if "backlog" in name:
        score += 85
    if "todo" in name:
        score += 80

    if name.endswith(".json"):
        score += 18
    elif name.endswith((".yaml", ".yml")):
        score += 14
    elif name.endswith(".md"):
        score += 8

    score -= depth * 3
    return score


def load_board(path: Path) -> Board:
    lower = path.name.lower()
    text = path.read_text(encoding="utf-8")
    if lower.endswith(".json"):
        return parse_json_board(path, text)
    if lower.endswith((".yaml", ".yml")):
        return parse_yaml_board(path, text)
    if lower.endswith(".md"):
        return parse_markdown_board(path, text)
    fail(f"unsupported board format: {path}")


def parse_json_board(path: Path, text: str) -> Board:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path}: {exc}")

    root_kind: str
    root_key: str | None = None
    task_list: list[Any]

    if isinstance(data, list):
        root_kind = "array"
        task_list = data
    elif isinstance(data, dict):
        key = None
        for candidate in TASK_KEYS:
            value = data.get(candidate)
            if isinstance(value, list):
                key = candidate
                break
        if key is None:
            for k, v in data.items():
                if isinstance(v, list) and v and isinstance(v[0], dict):
                    key = k
                    break
        if key is None:
            fail(f"could not locate task array in JSON board: {path}")
        root_kind = "key"
        root_key = key
        task_list = data[key]
    else:
        fail(f"unsupported JSON board shape in {path}: expected array or object")

    tasks: list[Task] = []
    for idx, item in enumerate(task_list):
        if not isinstance(item, dict):
            continue
        tasks.append(to_task(idx, item))

    if not tasks:
        fail(f"no task objects found in JSON board: {path}")
    return Board(path=path, fmt="json", tasks=tasks, data=data, root_kind=root_kind, root_key=root_key)


def parse_yaml_board(path: Path, text: str) -> Board:
    data: Any = None
    parser_used = "simple"
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
        parser_used = "pyyaml"
    except Exception:
        data = None

    if data is None:
        data = parse_yaml_via_ruby(text)
        if data is not None:
            parser_used = "ruby"

    if data is None:
        data = parse_simple_yaml(text)
        parser_used = "simple"

    if data is None:
        fail(f"unable to parse YAML board {path}. install python pyyaml or ruby for broader YAML support")

    root_kind: str
    root_key: str | None = None
    task_list: list[Any]

    if isinstance(data, list):
        root_kind = "array"
        task_list = data
    elif isinstance(data, dict):
        key = None
        for candidate in TASK_KEYS:
            value = data.get(candidate)
            if isinstance(value, list):
                key = candidate
                break
        if key is None:
            fail(f"could not locate task array in YAML board: {path}")
        root_kind = "key"
        root_key = key
        task_list = data[key]
    else:
        fail(f"unsupported YAML board shape in {path}")

    tasks: list[Task] = []
    for idx, item in enumerate(task_list):
        if not isinstance(item, dict):
            continue
        tasks.append(to_task(idx, item, {"yaml_parser": parser_used}))

    if not tasks:
        fail(f"no task objects found in YAML board: {path}")
    return Board(path=path, fmt="yaml", tasks=tasks, data=data, root_kind=root_kind, root_key=root_key)


def parse_yaml_via_ruby(text: str) -> Any:
    ruby = shutil.which("ruby")
    if not ruby:
        return None
    code = "require 'yaml'; require 'json'; input = STDIN.read; obj = YAML.load(input); puts JSON.generate(obj)"
    proc = subprocess.run([ruby, "-e", code], input=text, capture_output=True, text=True)
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except Exception:
        return None


def parse_simple_yaml(text: str) -> Any:
    # Strict subset:
    # - top-level array of maps
    # - or top-level key "tasks-like" -> array of maps
    lines = text.splitlines()
    stripped = [line.rstrip("\n") for line in lines]

    key_match = None
    for line in stripped:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_-]+):\s*$", line.strip())
        if m and m.group(1) in TASK_KEYS:
            key_match = m.group(1)
            break
        break

    if key_match:
        items = parse_simple_yaml_list(stripped, require_indent=True)
        return {key_match: items}
    items = parse_simple_yaml_list(stripped, require_indent=False)
    return items if items else None


def parse_simple_yaml_list(lines: list[str], require_indent: bool) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    in_dep_list = False
    dep_key = "depends_on"

    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        line = raw.rstrip()
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()

        if require_indent and indent == 0 and not re.match(r"^[A-Za-z0-9_-]+:\s*$", stripped):
            continue

        m_item = re.match(r"^-\s*(.*)$", stripped)
        if m_item and (not require_indent or indent >= 2):
            if current is not None:
                items.append(current)
            current = {}
            in_dep_list = False
            body = m_item.group(1).strip()
            if body and ":" in body:
                k, v = body.split(":", 1)
                current[k.strip()] = parse_yaml_scalar(v.strip())
            continue

        if current is None:
            continue

        m_kv = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", stripped)
        if m_kv:
            key = m_kv.group(1).strip()
            value = m_kv.group(2).strip()
            if value == "":
                if key in {"depends_on", "dependencies", "blocked_by", "requires", "prereqs"}:
                    current[key] = []
                    in_dep_list = True
                    dep_key = key
                else:
                    current[key] = ""
                    in_dep_list = False
            else:
                current[key] = parse_yaml_scalar(value)
                in_dep_list = False
            continue

        m_dep = re.match(r"^-\s*(.+)$", stripped)
        if in_dep_list and m_dep:
            val = parse_yaml_scalar(m_dep.group(1).strip())
            if not isinstance(current.get(dep_key), list):
                current[dep_key] = []
            current[dep_key].append(val)

    if current is not None:
        items.append(current)
    return items


def parse_yaml_scalar(value: str) -> Any:
    v = value.strip()
    if not v:
        return ""
    if v.startswith(("'", '"')) and v.endswith(("'", '"')) and len(v) >= 2:
        return v[1:-1]
    if v.lower() in {"true", "false"}:
        return v.lower() == "true"
    if re.fullmatch(r"-?[0-9]+", v):
        try:
            return int(v)
        except Exception:
            return v
    if v.startswith("[") and v.endswith("]"):
        body = v[1:-1].strip()
        if not body:
            return []
        return [parse_yaml_scalar(x.strip()) for x in body.split(",")]
    return v


def parse_markdown_board(path: Path, text: str) -> Board:
    lines = text.splitlines()
    tasks: list[Task] = []
    for line_no, line in enumerate(lines):
        m = re.match(r"^\s*[-*]\s+\[([ xX])\]\s+(.*)$", line)
        if not m:
            continue
        checked = m.group(1).lower() == "x"
        body = m.group(2).strip()
        parsed = parse_markdown_task_body(body)
        obj: dict[str, Any] = {
            "id": parsed.get("id"),
            "title": parsed.get("title", body),
            "status": parsed.get("status") or ("done" if checked else "todo"),
            "priority": parsed.get("priority"),
            "depends_on": parsed.get("depends_on", []),
        }
        task = to_task(
            idx=len(tasks),
            obj=obj,
            extra_locator={"line_no": line_no, "original_text": body},
        )
        tasks.append(task)

    if not tasks:
        fail(f"no markdown checklist tasks found in {path}")
    return Board(path=path, fmt="markdown", tasks=tasks, data=None, root_kind="markdown", markdown_lines=lines)


def parse_markdown_task_body(body: str) -> dict[str, Any]:
    result: dict[str, Any] = {"title": body, "depends_on": []}
    text = body

    m_id_bracket = re.match(r"^\[([A-Za-z0-9._-]+)\]\s*[:\-]?\s*(.+)$", text)
    if m_id_bracket:
        result["id"] = m_id_bracket.group(1)
        text = m_id_bracket.group(2).strip()
    else:
        m_id_prefix = re.match(r"^([A-Za-z][A-Za-z0-9_-]*-\d+[A-Za-z0-9_-]*)\s*[:\-]\s*(.+)$", text)
        if m_id_prefix:
            result["id"] = m_id_prefix.group(1)
            text = m_id_prefix.group(2).strip()

    status_match = re.search(r"\bstatus\s*[:=]\s*([A-Za-z0-9_-]+)", text, flags=re.IGNORECASE)
    if status_match:
        result["status"] = status_match.group(1)

    prio_match = re.search(r"\b(?:priority|prio)\s*[:=]\s*([A-Za-z0-9_-]+)", text, flags=re.IGNORECASE)
    if prio_match:
        result["priority"] = prio_match.group(1)

    dep_match = re.search(
        r"\b(?:depends_on|dependencies|blocked_by|requires|prereqs?|gateblocking)\s*[:=]\s*([A-Za-z0-9,._\-\s]+)",
        text,
        flags=re.IGNORECASE,
    )
    if dep_match:
        result["depends_on"] = split_depends(dep_match.group(1))

    clean = re.sub(r"\((?:status|priority|prio|depends_on|dependencies|blocked_by|requires|prereqs?|gateblocking)\s*:[^)]+\)", "", text, flags=re.IGNORECASE)
    result["title"] = clean.strip() if clean.strip() else text
    return result


def resolve_task(board: Board, task_ref: str) -> Task:
    for task in board.tasks:
        if task.id == task_ref or task.ref == task_ref:
            return task

    m = re.match(r"^idx:(\d+):h:([0-9a-fA-F]{4,64})$", task_ref)
    if m:
        idx = int(m.group(1))
        prefix = m.group(2).lower()
        for task in board.tasks:
            if task.index == idx and task.content_hash.startswith(prefix):
                return task
        fail(f"task ref no longer matches board content (locator drift): {task_ref}")
    fail(f"task not found: {task_ref}")


def compute_dependency_details(board: Board, task: Task) -> tuple[list[dict[str, Any]], list[str]]:
    by_id = {t.id: t for t in board.tasks if t.id}
    details: list[dict[str, Any]] = []
    unresolved: list[str] = []

    for dep in task.depends_on:
        dep_task = by_id.get(dep)
        if dep_task is None:
            details.append({"id": dep, "exists": False, "status": "missing", "done": False, "title": None})
            unresolved.append(dep)
            continue
        done = dep_task.status == "done"
        details.append(
            {"id": dep_task.id, "exists": True, "status": dep_task.status, "done": done, "title": dep_task.title}
        )
        if not done:
            unresolved.append(dep)
    return details, unresolved


def blocked_by_tasks(board: Board, task: Task) -> list[Task]:
    keys = {x for x in [task.id, task.ref] if x}
    out: list[Task] = []
    for candidate in board.tasks:
        if any(dep in keys for dep in candidate.depends_on):
            out.append(candidate)
    return out


def next_task(board: Board) -> tuple[Task | None, list[dict[str, Any]], int, int]:
    ready: list[Task] = []
    blocked_todo_count = 0
    for task in board.tasks:
        if task.status != "todo":
            continue
        _, unresolved = compute_dependency_details(board, task)
        if unresolved:
            blocked_todo_count += 1
            continue
        ready.append(task)

    ready.sort(key=lambda t: (-PRIORITY_RANK.get(t.priority, 2), t.id or t.ref))
    queue = [{"ref": t.ref, "id": t.id, "priority": t.priority, "title": t.title} for t in ready[:10]]
    return (ready[0] if ready else None), queue, blocked_todo_count, len(ready)


def chain_view(board: Board, task: Task) -> dict[str, Any]:
    if task.id:
        m = re.match(r"^([A-Za-z0-9_.-]*-\d+)[A-Za-z]?$", task.id)
        if m:
            root = m.group(1)
            chain = [t for t in board.tasks if t.id and t.id.startswith(root)]
            chain.sort(key=lambda t: t.id or "")
        else:
            root = "board"
            chain = sorted(board.tasks, key=lambda t: t.index)
    else:
        root = "board"
        chain = sorted(board.tasks, key=lambda t: t.index)

    refs = [t.ref for t in chain]
    idx = refs.index(task.ref)
    prev_ref = refs[idx - 1] if idx > 0 else None
    next_ref = refs[idx + 1] if idx < len(refs) - 1 else None
    return {
        "requested_task_ref": task.ref,
        "requested_task_id": task.id,
        "chain_root": root,
        "chain_count": len(chain),
        "position": idx,
        "previous_task_ref": prev_ref,
        "next_task_ref": next_ref,
        "chain": [
            {
                "ref": t.ref,
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "priority": t.priority,
                "depends_on": t.depends_on,
            }
            for t in chain
        ],
    }


def write_board(board: Board) -> None:
    if board.fmt == "json":
        board.path.write_text(json.dumps(board.data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return
    if board.fmt == "yaml":
        board.path.write_text(render_yaml(board.data, board.root_kind, board.root_key) + "\n", encoding="utf-8")
        return
    if board.fmt == "markdown":
        assert board.markdown_lines is not None
        board.path.write_text("\n".join(board.markdown_lines) + "\n", encoding="utf-8")
        return
    fail(f"unsupported write format: {board.fmt}")


def render_yaml(data: Any, root_kind: str, root_key: str | None) -> str:
    if root_kind == "array":
        if not isinstance(data, list):
            fail("yaml write failed: expected top-level array")
        return render_yaml_list(data, indent=0)
    if root_kind == "key":
        if not isinstance(data, dict):
            fail("yaml write failed: expected top-level object")
        if root_key is None:
            fail("yaml write failed: missing root key")
        if len(data.keys()) != 1:
            fail("yaml write refused: top-level YAML object has extra keys; unsupported for safe rewriting")
        arr = data.get(root_key)
        if not isinstance(arr, list):
            fail("yaml write failed: task key is not a list")
        rendered = render_yaml_list(arr, indent=2)
        return f"{root_key}:\n{rendered}"
    fail("yaml write failed: unsupported root kind")


def render_yaml_list(items: list[Any], indent: int) -> str:
    pad = " " * indent
    lines: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        keys = list(item.keys())
        if not keys:
            lines.append(f"{pad}- {{}}")
            continue
        first_key = keys[0]
        first_val = item[first_key]
        lines.append(f"{pad}- {first_key}: {yaml_scalar(first_val)}")
        for key in keys[1:]:
            val = item[key]
            if isinstance(val, list):
                if not val:
                    lines.append(f"{pad}  {key}: []")
                else:
                    lines.append(f"{pad}  {key}:")
                    for elem in val:
                        lines.append(f"{pad}    - {yaml_scalar(elem)}")
            else:
                lines.append(f"{pad}  {key}: {yaml_scalar(val)}")
    return "\n".join(lines)


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text == "":
        return '""'
    if re.search(r"[:#\[\]\{\},]|^\s|\s$|\n", text):
        return json.dumps(text, ensure_ascii=False)
    return text


def target_task_list(board: Board) -> list[dict[str, Any]]:
    if board.fmt == "json":
        if board.root_kind == "array":
            if not isinstance(board.data, list):
                fail("json board shape changed unexpectedly")
            return board.data
        if board.root_kind == "key":
            if not isinstance(board.data, dict) or board.root_key is None:
                fail("json board shape changed unexpectedly")
            arr = board.data.get(board.root_key)
            if not isinstance(arr, list):
                fail("json board shape changed unexpectedly")
            return arr
    if board.fmt == "yaml":
        if board.root_kind == "array":
            if not isinstance(board.data, list):
                fail("yaml board shape changed unexpectedly")
            return board.data
        if board.root_kind == "key":
            if not isinstance(board.data, dict) or board.root_key is None:
                fail("yaml board shape changed unexpectedly")
            arr = board.data.get(board.root_key)
            if not isinstance(arr, list):
                fail("yaml board shape changed unexpectedly")
            return arr
    fail("unsupported board format for structured task list updates")


def set_status_key(task_obj: dict[str, Any], new_status: str) -> None:
    for key in ["status", "state", "column", "stage"]:
        if key in task_obj:
            task_obj[key] = new_status
            return
    task_obj["status"] = new_status


def command_next(args: argparse.Namespace) -> dict[str, Any]:
    board_path = discover_board(Path.cwd(), args.board)
    board = load_board(board_path)
    next_item, queue, blocked_count, ready_count = next_task(board)
    return {
        "board": board.meta(),
        "selection_strategy": "ready todos sorted by priority (high>medium>low), then ID/ref",
        "ready_count": ready_count,
        "blocked_todo_count": blocked_count,
        "next_task_ref": (next_item.ref if next_item else None),
        "next_task_id": (next_item.id if next_item else None),
        "next_task": (next_item.as_public() if next_item else None),
        "ready_queue": queue,
    }


def command_task(args: argparse.Namespace) -> dict[str, Any]:
    board_path = discover_board(Path.cwd(), args.board)
    board = load_board(board_path)
    task = resolve_task(board, args.task_ref)
    dep_details, unresolved = compute_dependency_details(board, task)
    blocked_by = blocked_by_tasks(board, task)
    return {
        "board": board.meta(),
        "task": task.as_public(),
        "dependency_details": dep_details,
        "unresolved_dependencies": unresolved,
        "is_blocked": len(unresolved) > 0,
        "ready_to_start": task.status == "todo" and len(unresolved) == 0,
        "blocked_by_count": len(blocked_by),
        "blocked_by": [
            {"ref": t.ref, "id": t.id, "title": t.title, "status": t.status, "priority": t.priority}
            for t in blocked_by
        ],
    }


def command_chain(args: argparse.Namespace) -> dict[str, Any]:
    board_path = discover_board(Path.cwd(), args.board)
    board = load_board(board_path)
    task = resolve_task(board, args.task_ref)
    payload = chain_view(board, task)
    payload["board"] = board.meta()
    return payload


def command_set_status(args: argparse.Namespace) -> dict[str, Any]:
    board_path = discover_board(Path.cwd(), args.board)
    board = load_board(board_path)
    task = resolve_task(board, args.task_ref)
    new_status = normalize_status(args.status, default="")
    if new_status == "":
        fail(f"invalid status: {args.status}")

    if board.fmt in {"json", "yaml"}:
        arr = target_task_list(board)
        if task.index >= len(arr):
            fail("task index out of range while writing board")
        task_obj = arr[task.index]
        if not isinstance(task_obj, dict):
            fail("target task is not an object")
        if task.id and str(task_obj.get("id", "")).strip() not in {"", task.id}:
            fail("task identity mismatch while writing board")
        if not task.id:
            ref_hash = task.ref.split(":h:", 1)[1]
            if not task.content_hash.startswith(ref_hash):
                fail("task locator hash mismatch")
        set_status_key(task_obj, new_status)
    elif board.fmt == "markdown":
        assert board.markdown_lines is not None
        line_no = task.source_locator.get("line_no")
        if line_no is None or not (0 <= int(line_no) < len(board.markdown_lines)):
            fail("markdown task locator missing line number")
        original = board.markdown_lines[int(line_no)]
        m = re.match(r"^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$", original)
        if not m:
            fail("markdown task line no longer matches checklist format")
        mark = "x" if new_status == "done" else " "
        body = m.group(4)
        body = re.sub(r"\(\s*status\s*:\s*[A-Za-z0-9_-]+\s*\)", "", body, flags=re.IGNORECASE).strip()
        if new_status not in {"todo", "done"}:
            body = f"{body} (status: {new_status})"
        board.markdown_lines[int(line_no)] = f"{m.group(1)}{mark}{m.group(3)}{body}"
    else:
        fail(f"set-status not supported for board format: {board.fmt}")

    write_board(board)
    updated = load_board(board_path)
    if task.id:
        updated_task = resolve_task(updated, task.id)
    else:
        if task.index >= len(updated.tasks):
            fail("updated task index out of range")
        updated_task = updated.tasks[task.index]
    return {
        "board": updated.meta(),
        "ok": True,
        "task_ref": updated_task.ref,
        "task_id": updated_task.id,
        "status": updated_task.status,
    }


def parse_list_arg(value: str | None) -> list[str]:
    if value is None:
        return []
    return split_depends(value)


def command_add_task(args: argparse.Namespace) -> dict[str, Any]:
    board_path = discover_board(Path.cwd(), args.board)
    board = load_board(board_path)

    task_id = args.id.strip() if args.id else None
    title = args.title.strip()
    if not title:
        fail("title is required")
    status = normalize_status(args.status, default="todo")
    priority = normalize_priority(args.priority, default="medium")
    depends_on = parse_list_arg(args.depends_on)

    task_obj: dict[str, Any] = {
        "title": title,
        "status": status,
        "priority": priority,
        "depends_on": depends_on,
    }
    if task_id:
        task_obj["id"] = task_id
    if args.description:
        task_obj["description"] = args.description
    if args.type:
        task_obj["type"] = args.type

    if board.fmt in {"json", "yaml"}:
        arr = target_task_list(board)
        arr.append(task_obj)
        write_board(board)
    elif board.fmt == "markdown":
        assert board.markdown_lines is not None
        check = "x" if status == "done" else " "
        lead = f"[{task_id}] " if task_id else ""
        meta: list[str] = []
        if priority != "medium":
            meta.append(f"priority: {priority}")
        if depends_on:
            meta.append(f"depends_on: {', '.join(depends_on)}")
        if status not in {"todo", "done"}:
            meta.append(f"status: {status}")
        suffix = f" ({') ('.join(meta)})" if meta else ""
        line = f"- [{check}] {lead}{title}{suffix}"
        if board.markdown_lines and board.markdown_lines[-1].strip():
            board.markdown_lines.append("")
        board.markdown_lines.append(line)
        write_board(board)
    else:
        fail(f"add-task not supported for board format: {board.fmt}")

    updated = load_board(board_path)
    added = resolve_task(updated, task_id) if task_id else updated.tasks[-1]
    return {"board": updated.meta(), "ok": True, "task": added.as_public()}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ralph taskq",
        description="Cross-repo task board query and update utility (JSON/YAML/Markdown).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_next = subparsers.add_parser("next", help="Select the next actionable task")
    p_next.add_argument("--board", help="Explicit board file path")
    p_next.set_defaults(handler=command_next)

    p_task = subparsers.add_parser("task", help="Show full context for a specific task ref")
    p_task.add_argument("task_ref", help="Task ID or locator ref")
    p_task.add_argument("--board", help="Explicit board file path")
    p_task.set_defaults(handler=command_task)

    p_chain = subparsers.add_parser("chain", help="Show chain neighbors for a task")
    p_chain.add_argument("task_ref", help="Task ID or locator ref")
    p_chain.add_argument("--board", help="Explicit board file path")
    p_chain.set_defaults(handler=command_chain)

    p_set = subparsers.add_parser("set-status", help="Update a task status")
    p_set.add_argument("task_ref", help="Task ID or locator ref")
    p_set.add_argument("status", help="todo | in_progress | done | blocked (aliases allowed)")
    p_set.add_argument("--board", help="Explicit board file path")
    p_set.set_defaults(handler=command_set_status)

    p_add = subparsers.add_parser("add-task", help="Append one task to the selected board")
    p_add.add_argument("--title", required=True, help="Task title")
    p_add.add_argument("--id", help="Optional explicit task ID")
    p_add.add_argument("--status", default="todo", help="Task status (default: todo)")
    p_add.add_argument("--priority", default="medium", help="Task priority (default: medium)")
    p_add.add_argument("--depends-on", help="Comma/space-separated dependency IDs")
    p_add.add_argument("--description", help="Optional description")
    p_add.add_argument("--type", help="Optional type")
    p_add.add_argument("--board", help="Explicit board file path")
    p_add.set_defaults(handler=command_add_task)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = args.handler(args)
    except TaskqError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
