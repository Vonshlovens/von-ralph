use anyhow::{Context, Result};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use serde_json;

#[derive(Clone, Debug)]
pub struct RalphInstance {
    pub name: String,
    pub pid: u32,
    pub prompt: String,
    pub max_runs: u32,
    pub model: String,
    pub harness: String,
    pub work_dir: String,
    pub marathon: bool,
    pub started: String,
    pub current_run: u32,
    pub alive: bool,
    pub log_path: PathBuf,
    pub has_log: bool,
    /// Run id for ralph-next runs (SQLite state); None for legacy bash ralphs.
    pub run_id: Option<String>,
    /// running | finished | failed | stopped (ralph-next), or "legacy".
    pub status: String,
    pub stop_reason: Option<String>,
}

#[derive(Clone)]
pub struct RalphPreset {
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub model: String,
    pub harness: String,
    pub dir: String,
    pub max_runs: u32,
    pub marathon: bool,
}

pub const HARNESSES: &[&str] = &["claude", "codex", "opencode", "gh"];

pub fn default_model_for_harness(harness: &str) -> &'static str {
    match harness {
        "codex" => "",
        "opencode" => "openai/gpt-6.1-terra",
        "gh" => "",
        _ => "opus",
    }
}

pub fn load_presets() -> Vec<RalphPreset> {
    let dir = find_presets_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let mut presets = Vec::new();
    let mut paths: Vec<_> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .map(|e| e.path())
        .collect();
    paths.sort();
    for path in paths {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let str_field = |key: &str| v[key].as_str().unwrap_or("").to_string();
                let harness = v["harness"].as_str().unwrap_or("claude").to_string();
                let model = {
                    let m = str_field("model");
                    if m.is_empty() { default_model_for_harness(&harness).to_string() } else { m }
                };
                presets.push(RalphPreset {
                    name: str_field("name"),
                    description: str_field("description"),
                    prompt: str_field("prompt"),
                    model,
                    harness,
                    dir: str_field("dir"),
                    max_runs: v["max_runs"].as_u64().unwrap_or(0) as u32,
                    marathon: v["marathon"].as_bool().unwrap_or(false),
                });
            }
        }
    }
    presets
}

fn find_presets_dir() -> PathBuf {
    for c in repo_candidates() {
        let p = c.join("presets");
        if p.is_dir() {
            return p;
        }
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ralph/presets")
}

/// Candidate locations for the von-ralph repo root, in priority order.
fn repo_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // 1. Explicit override via env var
    if let Ok(p) = std::env::var("VON_RALPH_HOME") {
        out.push(PathBuf::from(p));
    }

    // 2. Three dirs up from the running binary
    //    (works for target/release/ralph-tui and cargo-installed in any layout
    //    where the binary sits inside the repo)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            out.push(parent.join("../../.."));
        }
    }

    // 3. Common locations under $HOME
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("von/ralph"));
        out.push(home.join("von-ralph"));
        out.push(home.join("projects/von-ralph"));
    }

    out
}

pub struct SpawnOpts {
    pub prompt: String,
    pub max_runs: u32,
    pub model: String,
    pub harness: String,
    pub dir: String,
    pub name: String,
    pub marathon: bool,
}

fn ralph_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ralph")
}

fn pid_dir() -> PathBuf {
    ralph_dir().join("pids")
}

fn log_dir() -> PathBuf {
    ralph_dir().join("logs")
}

fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn parse_meta(path: &Path) -> Option<RalphInstance> {
    let content = fs::read_to_string(path).ok()?;
    let mut name = String::new();
    let mut pid: u32 = 0;
    let mut prompt = String::new();
    let mut max_runs: u32 = 0;
    let mut model = String::from("opus");
    let mut harness = String::from("claude");
    let mut work_dir = String::new();
    let mut marathon = false;
    let mut started = String::new();
    let mut current_run: u32 = 0;

    for line in content.lines() {
        if let Some((key, val)) = line.split_once('=') {
            match key.trim() {
                "name" => name = val.trim().to_string(),
                "pid" => pid = val.trim().parse().unwrap_or(0),
                "prompt" => prompt = val.trim().to_string(),
                "max_runs" => max_runs = val.trim().parse().unwrap_or(0),
                "model" => model = val.trim().to_string(),
                "harness" => harness = val.trim().to_string(),
                "work_dir" => work_dir = val.trim().to_string(),
                "marathon" => marathon = val.trim() == "true",
                "started" => started = val.trim().to_string(),
                "current_run" => current_run = val.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    if harness.is_empty() {
        harness = "claude".to_string();
    }

    if name.is_empty() {
        name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
    }

    let log_path = log_dir().join(format!("{}.log", name));
    let has_log = log_path.exists();
    let alive = is_alive(pid);

    Some(RalphInstance {
        name,
        pid,
        prompt,
        max_runs,
        model,
        harness,
        work_dir,
        marathon,
        started,
        current_run,
        alive,
        log_path,
        has_log,
        run_id: None,
        status: "legacy".to_string(),
        stop_reason: None,
    })
}

/// ralph-next state root: $RALPH_HOME or ~/.ralph/v2 (see docs/state-schema.md).
fn v2_root() -> PathBuf {
    std::env::var_os("RALPH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| ralph_dir().join("v2"))
}

/// Latest run per name from ralph-next's SQLite database (read-only).
fn list_v2() -> Vec<RalphInstance> {
    let db = v2_root().join("ralph.db");
    if !db.exists() {
        return vec![];
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, pid, harness, model, prompt, max_iterations, marathon, dir, \
                started_at, current_iteration, status, stop_reason \
         FROM runs r WHERE started_at = (SELECT MAX(started_at) FROM runs WHERE name = r.name)",
    ) else {
        return vec![];
    };
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let pid: i64 = row.get(2)?;
        let status: String = row.get(11)?;
        let log_path = v2_root().join("runs").join(&id).join("log");
        Ok(RalphInstance {
            name: row.get(1)?,
            pid: pid.max(0) as u32,
            harness: row.get(3)?,
            model: row.get::<_, Option<String>>(4)?.unwrap_or_else(|| "(default)".to_string()),
            prompt: row.get(5)?,
            max_runs: row.get::<_, i64>(6)?.max(0) as u32,
            marathon: row.get::<_, i64>(7)? != 0,
            work_dir: row.get(8)?,
            started: row.get(9)?,
            current_run: row.get::<_, i64>(10)?.max(0) as u32,
            alive: status == "running" && is_alive(pid.max(0) as u32),
            has_log: log_path.exists(),
            log_path,
            run_id: Some(id),
            status,
            stop_reason: row.get(12)?,
        })
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => vec![],
    }
}

fn find_v2(name: &str) -> Option<RalphInstance> {
    list_v2().into_iter().find(|i| i.name == name)
}

pub fn list_instances() -> Vec<RalphInstance> {
    let mut instances = list_v2();
    let mut known_names: HashSet<String> = instances.iter().map(|i| i.name.clone()).collect();

    // Read meta files
    if let Ok(entries) = fs::read_dir(pid_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("meta") {
                if let Some(inst) = parse_meta(&path) {
                    // A dead legacy record shadowed by a ralph-next run of the same name is noise.
                    if known_names.contains(&inst.name) && !inst.alive {
                        continue;
                    }
                    known_names.insert(inst.name.clone());
                    instances.push(inst);
                }
            }
        }
    }

    // Discover orphan logs
    if let Ok(entries) = fs::read_dir(log_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("log") {
                let name = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if known_names.contains(&name) {
                    continue;
                }
                let started = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| {
                        let duration = t
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default();
                        Some(format!("(log modified: {}s ago)",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs()
                                .saturating_sub(duration.as_secs())
                        ))
                    })
                    .unwrap_or_default();

                instances.push(RalphInstance {
                    name,
                    pid: 0,
                    prompt: "(finished — check log)".to_string(),
                    max_runs: 0,
                    model: "?".to_string(),
                    harness: "?".to_string(),
                    work_dir: String::new(),
                    marathon: false,
                    started,
                    current_run: 0,
                    alive: false,
                    log_path: path,
                    has_log: true,
                    run_id: None,
                    status: "legacy".to_string(),
                    stop_reason: None,
                });
            }
        }
    }

    // Sort: alive first, then ralph-next runs (newest first), then legacy by name
    instances.sort_by(|a, b| {
        b.alive
            .cmp(&a.alive)
            .then(b.run_id.is_some().cmp(&a.run_id.is_some()))
            .then(b.started.cmp(&a.started))
            .then(a.name.cmp(&b.name))
    });
    instances
}

pub fn kill_instance(name: &str) -> Result<String> {
    if let Some(inst) = find_v2(name) {
        if inst.status == "running" {
            return run_next(&["stop", name]);
        }
    }
    let meta_path = pid_dir().join(format!("{}.meta", name));
    if !meta_path.exists() {
        anyhow::bail!("No ralph named '{}' found", name);
    }

    let inst = parse_meta(&meta_path).context("Failed to parse meta")?;

    if !inst.alive {
        clean_meta(name);
        return Ok(format!("{} was already dead (cleaned up)", name));
    }

    // Kill process group
    unsafe {
        libc::kill(-(inst.pid as i32), libc::SIGTERM);
    }
    // Kill PID directly
    unsafe {
        libc::kill(inst.pid as i32, libc::SIGTERM);
    }
    // Kill children via pkill
    let _ = Command::new("pkill")
        .args(["-TERM", "-P", &inst.pid.to_string()])
        .output();

    Ok(format!("Killed {} (PID {})", name, inst.pid))
}

pub fn clean_dead() -> Vec<String> {
    let mut cleaned = Vec::new();
    if let Ok(out) = run_next(&["clean"]) {
        cleaned.extend(
            out.lines()
                .filter_map(|l| l.trim().strip_prefix("marked crashed: "))
                .map(|l| l.split(' ').next().unwrap_or(l).to_string()),
        );
    }
    if let Ok(entries) = fs::read_dir(pid_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("meta") {
                if let Some(inst) = parse_meta(&path) {
                    if !inst.alive {
                        clean_meta(&inst.name);
                        cleaned.push(inst.name);
                    }
                }
            }
        }
    }
    cleaned
}

fn clean_meta(name: &str) {
    let _ = fs::remove_file(pid_dir().join(format!("{}.meta", name)));
    let _ = fs::remove_file(pid_dir().join(format!("{}.pid", name)));
}

/// Path to the ralph-next CLI (bin/ralph-next in the repo).
pub fn ralph_next_path() -> PathBuf {
    if let Ok(p) = std::env::var("RALPH_NEXT_BIN") {
        return PathBuf::from(p);
    }
    for c in repo_candidates() {
        let p = c.join("bin/ralph-next");
        if p.exists() {
            return p;
        }
    }
    // Last resort: return a likely-broken path so the error message is useful
    dirs::home_dir().unwrap_or_default().join("von/ralph/bin/ralph-next")
}

/// Run a ralph-next subcommand and return its last output line (or the error text).
fn run_next(args: &[&str]) -> Result<String> {
    let bin = ralph_next_path();
    if !bin.exists() {
        anyhow::bail!("ralph-next not found at {}", bin.display());
    }
    let out = Command::new(&bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .context("Failed to run ralph-next")?;
    let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
    let stdout = text(&out.stdout);
    if out.status.success() {
        Ok(stdout.lines().last().unwrap_or("ok").trim().to_string())
    } else {
        let stderr = text(&out.stderr);
        let msg = if stderr.is_empty() { stdout } else { stderr };
        anyhow::bail!("{}", msg.lines().find(|l| !l.trim().is_empty()).unwrap_or("ralph-next failed"))
    }
}

pub fn spawn_ralph(opts: &SpawnOpts) -> Result<String> {
    if opts.prompt.trim().is_empty() {
        anyhow::bail!("a prompt is required");
    }
    let harness = if opts.harness.is_empty() { "claude" } else { opts.harness.as_str() };
    let max = opts.max_runs.to_string();
    let mut args: Vec<&str> = vec!["run", "--detach", "-H", harness, "-N", &max];
    if !opts.name.is_empty() {
        args.extend(["-n", &opts.name]);
    }
    if !opts.dir.is_empty() {
        args.extend(["-d", &opts.dir]);
    }
    if !opts.model.is_empty() && opts.model != default_model_for_harness(harness) {
        args.extend(["-m", &opts.model]);
    }
    if opts.marathon {
        args.push("--marathon");
    }
    args.push(&opts.prompt);
    let out = run_next(&args)?;
    // `ralph-next run --detach` prints "🚀 <name> started (run …)" then the log path.
    Ok(out.replace("   log ", "log: "))
}

pub fn steer_instance(name: &str, text: &str) -> Result<String> {
    if text.trim().is_empty() {
        anyhow::bail!("steer text is empty");
    }
    run_next(&["steer", name, text])
}

pub fn restart_instance(name: &str, new_max_runs: u32) -> Result<String> {
    if find_v2(name).is_some() {
        let max = new_max_runs.to_string();
        return run_next(&["restart", name, "-N", &max]);
    }
    let meta_path = pid_dir().join(format!("{}.meta", name));
    if !meta_path.exists() {
        anyhow::bail!("No ralph named '{}' found", name);
    }

    let inst = parse_meta(&meta_path).context("Failed to parse meta")?;

    if inst.alive {
        anyhow::bail!("{} is still running (PID {}). Kill it first.", name, inst.pid);
    }

    // Clean up old metadata
    clean_meta(name);

    // Respawn with the same settings
    let opts = SpawnOpts {
        prompt: inst.prompt,
        max_runs: new_max_runs,
        model: inst.model,
        harness: inst.harness,
        dir: inst.work_dir,
        name: inst.name.clone(),
        marathon: inst.marathon,
    };

    spawn_ralph(&opts)?;
    Ok(format!("Restarted {} (runs: {})", name, if new_max_runs == 0 { "unlimited".to_string() } else { new_max_runs.to_string() }))
}

pub fn read_log_tail(path: &Path, max_lines: usize) -> Vec<String> {
    let content = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

pub fn read_log_incremental(path: &Path, pos: u64) -> (Vec<String>, u64) {
    let Ok(mut file) = fs::File::open(path) else {
        return (vec![], pos);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len <= pos {
        return (vec![], pos);
    }
    if file.seek(SeekFrom::Start(pos)).is_err() {
        return (vec![], pos);
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return (vec![], pos);
    }
    let lines: Vec<String> = buf.lines().map(|s| s.to_string()).collect();
    (lines, len)
}
