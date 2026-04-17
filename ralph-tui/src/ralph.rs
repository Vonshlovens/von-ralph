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
    pub work_dir: String,
    pub marathon: bool,
    pub started: String,
    pub current_run: u32,
    pub alive: bool,
    pub log_path: PathBuf,
    pub has_log: bool,
}

#[derive(Clone)]
pub struct RalphPreset {
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub model: String,
    pub dir: String,
    pub max_runs: u32,
    pub marathon: bool,
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
                presets.push(RalphPreset {
                    name: str_field("name"),
                    description: str_field("description"),
                    prompt: str_field("prompt"),
                    model: str_field("model"),
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
    if let Ok(exe) = std::env::current_exe() {
        let candidate = exe
            .parent()
            .unwrap_or(Path::new("."))
            .join("../../../presets");
        if candidate.is_dir() {
            return candidate;
        }
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ralph/presets")
}

pub struct SpawnOpts {
    pub prompt: String,
    pub max_runs: u32,
    pub model: String,
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
                "work_dir" => work_dir = val.trim().to_string(),
                "marathon" => marathon = val.trim() == "true",
                "started" => started = val.trim().to_string(),
                "current_run" => current_run = val.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
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
        work_dir,
        marathon,
        started,
        current_run,
        alive,
        log_path,
        has_log,
    })
}

pub fn list_instances() -> Vec<RalphInstance> {
    let mut instances = Vec::new();
    let mut known_names = HashSet::new();

    // Read meta files
    if let Ok(entries) = fs::read_dir(pid_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("meta") {
                if let Some(inst) = parse_meta(&path) {
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
                    work_dir: String::new(),
                    marathon: false,
                    started,
                    current_run: 0,
                    alive: false,
                    log_path: path,
                    has_log: true,
                });
            }
        }
    }

    // Sort: alive first, then by name
    instances.sort_by(|a, b| b.alive.cmp(&a.alive).then(a.name.cmp(&b.name)));
    instances
}

pub fn kill_instance(name: &str) -> Result<String> {
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

pub fn ralph_bin_path() -> PathBuf {
    // Try relative to the binary's location first, then fallback
    if let Ok(exe) = std::env::current_exe() {
        let candidate = exe
            .parent()
            .unwrap_or(Path::new("."))
            .join("../../../ralph");
        if candidate.exists() {
            return candidate;
        }
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join("projects/von-ralph/ralph")
}

pub fn spawn_ralph(opts: &SpawnOpts) -> Result<String> {
    let bin = ralph_bin_path();
    if !bin.exists() {
        anyhow::bail!("ralph binary not found at {}", bin.display());
    }

    let mut args: Vec<String> = Vec::new();

    if !opts.prompt.is_empty() {
        args.push(opts.prompt.clone());
    }
    if opts.max_runs > 0 {
        args.push(opts.max_runs.to_string());
    }
    if !opts.name.is_empty() {
        args.push("-n".to_string());
        args.push(opts.name.clone());
    }
    if !opts.dir.is_empty() {
        args.push("-d".to_string());
        args.push(opts.dir.clone());
    }
    if opts.model != "opus" && !opts.model.is_empty() {
        args.push("-m".to_string());
        args.push(opts.model.clone());
    }
    if opts.marathon {
        args.push("--marathon".to_string());
    }

    let cwd = if opts.dir.is_empty() {
        std::env::current_dir().unwrap_or_default()
    } else {
        PathBuf::from(&opts.dir)
    };

    Command::new(&bin)
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Failed to spawn ralph")?;

    let name_display = if opts.name.is_empty() {
        "ralph (auto-named)"
    } else {
        &opts.name
    };
    Ok(format!("Launched {}", name_display))
}

pub fn restart_instance(name: &str, new_max_runs: u32) -> Result<String> {
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
