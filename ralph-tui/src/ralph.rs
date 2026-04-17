use anyhow::{Context, Result};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use serde_json;

pub mod harness {
    pub struct Resolved {
        pub cli: String,
        pub model: String,
    }

    struct HarnessEntry {
        cli: &'static str,
        aliases: &'static [&'static str],
        models: &'static [ModelEntry],
    }

    struct ModelEntry {
        canonical: &'static str,
        aliases: &'static [&'static str],
    }

    static HARNESSES: &[HarnessEntry] = &[
        HarnessEntry {
            cli: "claude",
            aliases: &["claude", "anthropic"],
            models: &[
                ModelEntry { canonical: "claude-opus-4-7", aliases: &["opus"] },
                ModelEntry { canonical: "claude-sonnet-4-6", aliases: &["sonnet"] },
                ModelEntry { canonical: "claude-haiku-4-5", aliases: &["haiku"] },
            ],
        },
        HarnessEntry {
            cli: "codex",
            aliases: &["codex"],
            models: &[
                ModelEntry { canonical: "gpt-5.3", aliases: &["5.3"] },
                ModelEntry { canonical: "gpt-5.3-codex", aliases: &["5.3codex", "codex"] },
                ModelEntry { canonical: "o4-mini", aliases: &["o4", "mini", "o4mini"] },
                ModelEntry { canonical: "o3", aliases: &["o3"] },
                ModelEntry { canonical: "gpt-4.1", aliases: &["gpt4", "gpt", "4.1"] },
                ModelEntry { canonical: "gpt-5.4", aliases: &["5.4", "gpt5"] },
            ],
        },
        HarnessEntry {
            cli: "gemini",
            aliases: &["gemini"],
            models: &[
                ModelEntry { canonical: "gemini-2.5-pro", aliases: &["pro", "2.5pro"] },
                ModelEntry { canonical: "gemini-2.5-flash", aliases: &["flash", "2.5flash"] },
                ModelEntry { canonical: "gemini-3-pro-preview", aliases: &["3pro", "gemini3"] },
                ModelEntry { canonical: "gemini-3-flash-preview", aliases: &["3flash"] },
            ],
        },
        HarnessEntry {
            cli: "opencode",
            aliases: &["opencode", "oc"],
            models: &[
                ModelEntry { canonical: "anthropic/claude-sonnet-4-6", aliases: &["sonnet", "claude"] },
                ModelEntry { canonical: "openai/gpt-5", aliases: &["gpt5", "gpt"] },
                ModelEntry { canonical: "google/gemini-2.5-pro", aliases: &["pro", "gemini"] },
            ],
        },
    ];

    pub fn resolve(raw: &str) -> Resolved {
        let raw = raw.trim();
        if raw.is_empty() {
            return Resolved { cli: "claude".to_string(), model: "claude-opus-4-7".to_string() };
        }

        let (head, tail_opt) = match raw.find(|c: char| c.is_whitespace()) {
            Some(pos) => (&raw[..pos], Some(raw[pos..].trim())),
            None => (raw, None),
        };

        let cli_match = if tail_opt.is_some() {
            HARNESSES.iter().find(|h| h.aliases.iter().any(|a| a.eq_ignore_ascii_case(head)))
        } else {
            None
        };

        let (harness, model_raw) = if let Some(h) = cli_match {
            (h, tail_opt.unwrap_or(""))
        } else {
            let claude = HARNESSES.iter().find(|h| h.cli == "claude").unwrap();
            (claude, raw)
        };

        Resolved { cli: harness.cli.to_string(), model: fuzzy_model(harness, model_raw) }
    }

    fn fuzzy_model(harness: &HarnessEntry, model_raw: &str) -> String {
        if model_raw.is_empty() {
            return harness.models.first().map(|m| m.canonical.to_string()).unwrap_or_default();
        }
        let lower = model_raw.to_lowercase();
        let mut best_score = 0i32;
        let mut best = harness.models.first().map(|m| m.canonical).unwrap_or("");
        for entry in harness.models {
            let s = score_model(entry, &lower);
            if s > best_score { best_score = s; best = entry.canonical; }
        }
        if best_score == 0 { model_raw.to_string() } else { best.to_string() }
    }

    fn score_model(entry: &ModelEntry, lower: &str) -> i32 {
        if entry.canonical.eq_ignore_ascii_case(lower) { return 3; }
        for alias in entry.aliases {
            let a = alias.to_lowercase();
            if a == lower { return 3; }
            if a.starts_with(lower) || lower.starts_with(&a) { return 2; }
            if a.contains(lower) || lower.contains(&a) { return 1; }
        }
        let c = entry.canonical.to_lowercase();
        if c.starts_with(lower) || lower.starts_with(&c) { return 2; }
        if c.contains(lower) || lower.contains(&c) { return 1; }
        0
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn test_bare_opus() {
            let r = resolve("opus");
            assert_eq!(r.cli, "claude");
            assert_eq!(r.model, "claude-opus-4-7");
        }

        #[test]
        fn test_claude_sonnet() {
            let r = resolve("claude sonnet");
            assert_eq!(r.cli, "claude");
            assert_eq!(r.model, "claude-sonnet-4-6");
        }

        #[test]
        fn test_codex_o4_mini() {
            let r = resolve("codex o4-mini");
            assert_eq!(r.cli, "codex");
            assert_eq!(r.model, "o4-mini");
        }

        #[test]
        fn test_gemini_flash() {
            let r = resolve("gemini flash");
            assert_eq!(r.cli, "gemini");
            assert_eq!(r.model, "gemini-2.5-flash");
        }

        #[test]
        fn test_opencode_sonnet() {
            let r = resolve("opencode sonnet");
            assert_eq!(r.cli, "opencode");
            assert_eq!(r.model, "anthropic/claude-sonnet-4-6");
        }

        #[test]
        fn test_empty() {
            let r = resolve("");
            assert_eq!(r.cli, "claude");
            assert_eq!(r.model, "claude-opus-4-7");
        }

        #[test]
        fn test_unknown_cli_falls_back_to_claude() {
            let r = resolve("unknowncli some-model");
            assert_eq!(r.cli, "claude");
        }
    }
}

#[derive(Clone, Debug)]
pub struct RalphInstance {
    pub name: String,
    pub pid: u32,
    pub prompt: String,
    pub max_runs: u32,
    pub model: String,
    pub cli: String,
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
    pub cli: String,
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
    let mut cli = String::from("claude");
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
                "cli" => cli = val.trim().to_string(),
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
        cli,
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
                    cli: "?".to_string(),
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

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    })
}

pub fn ralph_bin_path() -> PathBuf {
    // 1. Explicit env var override
    if let Ok(p) = std::env::var("RALPH_BIN") {
        return PathBuf::from(p);
    }
    // 2. Relative to the TUI binary (works in dev checkout)
    if let Ok(exe) = std::env::current_exe() {
        let candidate = exe
            .parent()
            .unwrap_or(Path::new("."))
            .join("../../../ralph");
        if candidate.exists() {
            return candidate;
        }
    }
    // 3. Search PATH
    if let Some(found) = find_in_path("ralph") {
        return found;
    }
    // 4. Bare name — let the OS try at spawn time
    PathBuf::from("ralph")
}

pub fn spawn_ralph(opts: &SpawnOpts) -> Result<String> {
    let bin = ralph_bin_path();
    if bin.is_absolute() && !bin.exists() {
        anyhow::bail!(
            "ralph binary not found at {}\nHint: set $RALPH_BIN or add ralph to your PATH",
            bin.display()
        );
    }
    if !opts.dir.is_empty() {
        let dir_path = PathBuf::from(&opts.dir);
        if !dir_path.exists() {
            anyhow::bail!("working directory does not exist: {}", opts.dir);
        }
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
    if !opts.model.is_empty() {
        args.push("-m".to_string());
        args.push(opts.model.clone());
    }
    if !opts.cli.is_empty() && opts.cli != "claude" {
        args.push("--cli".to_string());
        args.push(opts.cli.clone());
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
        cli: inst.cli,
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
