use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::time::Instant;

use crate::ralph::{
    self, default_model_for_harness, RalphInstance, RalphPreset, SpawnOpts, HARNESSES,
};

#[derive(PartialEq)]
pub enum View {
    List,
    Log,
    Launch,
    Restart,
}

pub struct TextInput {
    pub text: String,
    pub cursor: usize, // character position (not byte)
}

impl TextInput {
    pub fn new(text: &str) -> Self {
        let cursor = text.chars().count();
        Self { text: text.to_string(), cursor }
    }

    pub fn empty() -> Self {
        Self { text: String::new(), cursor: 0 }
    }

    pub fn set(&mut self, text: &str) {
        self.text = text.to_string();
        self.cursor = text.chars().count();
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
    }

    pub fn value(&self) -> &str {
        &self.text
    }

    /// Byte offset of cursor position (for rendering)
    pub fn cursor_byte_offset(&self) -> usize {
        self.text.char_indices()
            .nth(self.cursor)
            .map(|(i, _)| i)
            .unwrap_or(self.text.len())
    }

    pub fn insert_char(&mut self, c: char) {
        let byte_pos = self.cursor_byte_offset();
        self.text.insert(byte_pos, c);
        self.cursor += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            let byte_pos = self.cursor_byte_offset();
            self.text.remove(byte_pos);
        }
    }

    pub fn delete(&mut self) {
        let len = self.text.chars().count();
        if self.cursor < len {
            let byte_pos = self.cursor_byte_offset();
            self.text.remove(byte_pos);
        }
    }

    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_right(&mut self) {
        let len = self.text.chars().count();
        if self.cursor < len {
            self.cursor += 1;
        }
    }

    pub fn move_home(&mut self) {
        self.cursor = 0;
    }

    pub fn move_end(&mut self) {
        self.cursor = self.text.chars().count();
    }

    /// Handle a key event. Returns true if consumed.
    pub fn handle_key(&mut self, key: &KeyEvent) -> bool {
        match key.code {
            KeyCode::Char(c) => { self.insert_char(c); true }
            KeyCode::Backspace => { self.backspace(); true }
            KeyCode::Delete => { self.delete(); true }
            KeyCode::Left => { self.move_left(); true }
            KeyCode::Right => { self.move_right(); true }
            KeyCode::Home => { self.move_home(); true }
            KeyCode::End => { self.move_end(); true }
            _ => false,
        }
    }
}

// Field order: harness, prompt, model, dir, name, max_runs, marathon
pub const FIELD_HARNESS: usize = 0;
pub const FIELD_PROMPT: usize = 1;
pub const FIELD_MODEL: usize = 2;
pub const FIELD_DIR: usize = 3;
pub const FIELD_NAME: usize = 4;
pub const FIELD_MAX_RUNS: usize = 5;
pub const FIELD_MARATHON: usize = 6;
pub const FIELD_COUNT: usize = 7;

pub struct LaunchForm {
    pub fields: [TextInput; FIELD_COUNT],
    pub focused: usize,
    pub labels: [&'static str; FIELD_COUNT],
}

impl LaunchForm {
    pub fn new() -> Self {
        let dir = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        Self {
            fields: [
                TextInput::new("claude"),               // harness
                TextInput::empty(),                     // prompt
                TextInput::new(default_model_for_harness("claude")),
                TextInput::new(&dir),                   // dir
                TextInput::empty(),                     // name
                TextInput::new("0"),                    // max_runs
                TextInput::new("false"),                // marathon
            ],
            focused: 0,
            labels: ["Harness", "Prompt", "Model", "Directory", "Name", "Max runs", "Marathon"],
        }
    }

    pub fn reset(&mut self) {
        self.fields[FIELD_HARNESS].set("claude");
        self.fields[FIELD_PROMPT].clear();
        self.fields[FIELD_MODEL].set(default_model_for_harness("claude"));
        let dir = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        self.fields[FIELD_DIR].set(&dir);
        self.fields[FIELD_NAME].clear();
        self.fields[FIELD_MAX_RUNS].set("0");
        self.fields[FIELD_MARATHON].set("false");
        self.focused = FIELD_PROMPT;
    }

    /// Cycle harness by +/- 1. If the model field still holds the prior harness's
    /// default, update it to the new harness's default; otherwise leave the
    /// user's override alone.
    pub fn cycle_harness(&mut self, delta: i32) {
        let current = self.fields[FIELD_HARNESS].value().to_string();
        let prior_default = default_model_for_harness(&current).to_string();
        let idx = HARNESSES.iter().position(|h| *h == current.as_str()).unwrap_or(0) as i32;
        let len = HARNESSES.len() as i32;
        let new_idx = ((idx + delta) % len + len) % len;
        let new_harness = HARNESSES[new_idx as usize];
        self.fields[FIELD_HARNESS].set(new_harness);
        if self.fields[FIELD_MODEL].value() == prior_default {
            self.fields[FIELD_MODEL].set(default_model_for_harness(new_harness));
        }
    }
}

pub struct RestartForm {
    pub instance_name: String,
    pub max_runs: TextInput,
}

pub struct App {
    pub view: View,
    pub instances: Vec<RalphInstance>,
    pub selected: usize,
    pub log_content: Vec<String>,
    pub log_scroll: usize,
    pub log_auto_follow: bool,
    pub log_file_pos: u64,
    pub log_instance_name: String,
    pub launch_form: LaunchForm,
    pub restart_form: RestartForm,
    pub should_quit: bool,
    pub status_msg: String,
    pub confirm_kill: Option<(String, Instant)>,
    pub presets: Vec<RalphPreset>,
    pub preset_selected: usize,
    pub show_presets: bool,
}

impl App {
    pub fn new() -> Self {
        let mut app = Self {
            view: View::List,
            instances: Vec::new(),
            selected: 0,
            log_content: Vec::new(),
            log_scroll: 0,
            log_auto_follow: true,
            log_file_pos: 0,
            log_instance_name: String::new(),
            launch_form: LaunchForm::new(),
            restart_form: RestartForm { instance_name: String::new(), max_runs: TextInput::new("0") },
            should_quit: false,
            status_msg: String::new(),
            confirm_kill: None,
            presets: ralph::load_presets(),
            preset_selected: 0,
            show_presets: false,
        };
        app.refresh_instances();
        app
    }

    pub fn refresh_instances(&mut self) {
        self.instances = ralph::list_instances();
        if self.selected >= self.instances.len() && !self.instances.is_empty() {
            self.selected = self.instances.len() - 1;
        }
    }

    pub fn selected_instance(&self) -> Option<&RalphInstance> {
        self.instances.get(self.selected)
    }

    pub fn on_tick(&mut self) {
        match self.view {
            View::List => self.refresh_instances(),
            View::Log => self.refresh_log(),
            View::Launch | View::Restart => {}
        }
        // Expire kill confirmation after 3 seconds
        if let Some((_, when)) = &self.confirm_kill {
            if when.elapsed().as_secs() >= 3 {
                self.confirm_kill = None;
                self.status_msg.clear();
            }
        }
    }

    fn refresh_log(&mut self) {
        if let Some(inst) = self.instances.iter().find(|i| i.name == self.log_instance_name) {
            let path = inst.log_path.clone();
            let (new_lines, new_pos) = ralph::read_log_incremental(&path, self.log_file_pos);
            if !new_lines.is_empty() {
                self.log_content.extend(new_lines);
                self.log_file_pos = new_pos;
                if self.log_auto_follow {
                    self.log_scroll = self.log_content.len().saturating_sub(1);
                }
            }
        }
    }

    fn enter_log_view(&mut self) {
        let Some(inst) = self.instances.get(self.selected) else {
            return;
        };
        if !inst.has_log {
            self.status_msg = format!("No log file for {}", inst.name);
            return;
        }
        let name = inst.name.clone();
        let path = inst.log_path.clone();
        self.log_instance_name = name;
        self.log_content = ralph::read_log_tail(&path, 500);
        self.log_file_pos = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        self.log_auto_follow = true;
        self.log_scroll = self.log_content.len().saturating_sub(1);
        self.view = View::Log;
        self.status_msg.clear();
    }

    fn do_kill(&mut self, name: &str) {
        let name = name.to_string();
        match ralph::kill_instance(&name) {
            Ok(msg) => self.status_msg = msg,
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
        self.confirm_kill = None;
        self.refresh_instances();
    }

    fn do_clean(&mut self) {
        let cleaned = ralph::clean_dead();
        if cleaned.is_empty() {
            self.status_msg = "Nothing to clean".to_string();
        } else {
            self.status_msg = format!("Cleaned: {}", cleaned.join(", "));
        }
        self.refresh_instances();
    }

    fn do_launch(&mut self) {
        let opts = SpawnOpts {
            harness: self.launch_form.fields[FIELD_HARNESS].value().to_string(),
            prompt: self.launch_form.fields[FIELD_PROMPT].value().to_string(),
            model: self.launch_form.fields[FIELD_MODEL].value().to_string(),
            dir: self.launch_form.fields[FIELD_DIR].value().to_string(),
            name: self.launch_form.fields[FIELD_NAME].value().to_string(),
            max_runs: self.launch_form.fields[FIELD_MAX_RUNS].value().parse().unwrap_or(0),
            marathon: self.launch_form.fields[FIELD_MARATHON].value() == "true",
        };
        match ralph::spawn_ralph(&opts) {
            Ok(msg) => self.status_msg = msg,
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
        self.launch_form.reset();
        self.view = View::List;
        self.refresh_instances();
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        // Ctrl-C always quits
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.should_quit = true;
            return;
        }

        if self.show_presets {
            self.handle_presets_key(key);
            return;
        }

        match self.view {
            View::List => self.handle_list_key(key),
            View::Log => self.handle_log_key(key),
            View::Launch => self.handle_launch_key(key),
            View::Restart => self.handle_restart_key(key),
        }
    }

    fn handle_list_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('j') | KeyCode::Down => {
                if !self.instances.is_empty() {
                    self.selected = (self.selected + 1).min(self.instances.len() - 1);
                }
                self.confirm_kill = None;
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.selected = self.selected.saturating_sub(1);
                self.confirm_kill = None;
            }
            KeyCode::Enter | KeyCode::Char('l') => {
                self.enter_log_view();
            }
            KeyCode::Char('K') => {
                if let Some(inst) = self.selected_instance() {
                    let name = inst.name.clone();
                    if let Some((ref pending, _)) = self.confirm_kill {
                        if *pending == name {
                            self.do_kill(&name);
                            return;
                        }
                    }
                    self.status_msg = format!("Press K again to kill {}", name);
                    self.confirm_kill = Some((name, Instant::now()));
                }
            }
            KeyCode::Char('p') => {
                if !self.presets.is_empty() {
                    self.preset_selected = 0;
                    self.show_presets = true;
                    self.status_msg.clear();
                    self.confirm_kill = None;
                }
            }
            KeyCode::Char('n') => {
                self.launch_form.reset();
                self.view = View::Launch;
                self.status_msg.clear();
                self.confirm_kill = None;
            }
            KeyCode::Char('c') => {
                self.do_clean();
                self.confirm_kill = None;
            }
            KeyCode::Char('R') => {
                if let Some(inst) = self.selected_instance() {
                    if inst.alive {
                        self.status_msg = format!("{} is still running — kill it first", inst.name);
                    } else {
                        self.restart_form.instance_name = inst.name.clone();
                        self.restart_form.max_runs = TextInput::new("0");
                        self.view = View::Restart;
                        self.status_msg.clear();
                        self.confirm_kill = None;
                    }
                }
            }
            KeyCode::Char('r') => {
                self.refresh_instances();
                self.status_msg = "Refreshed".to_string();
            }
            _ => {}
        }
    }

    fn handle_log_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc | KeyCode::Backspace => {
                self.view = View::List;
                self.status_msg.clear();
            }
            KeyCode::Char('j') | KeyCode::Down => {
                self.log_scroll = (self.log_scroll + 1).min(self.log_content.len().saturating_sub(1));
                self.log_auto_follow = false;
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.log_scroll = self.log_scroll.saturating_sub(1);
                self.log_auto_follow = false;
            }
            KeyCode::Char('g') => {
                self.log_scroll = 0;
                self.log_auto_follow = false;
            }
            KeyCode::Char('G') => {
                self.log_scroll = self.log_content.len().saturating_sub(1);
                self.log_auto_follow = true;
            }
            KeyCode::Char('K') => {
                let name = self.log_instance_name.clone();
                if let Some((ref pending, _)) = self.confirm_kill {
                    if *pending == name {
                        self.do_kill(&name);
                        return;
                    }
                }
                self.status_msg = format!("Press K again to kill {}", name);
                self.confirm_kill = Some((name, Instant::now()));
            }
            KeyCode::PageDown => {
                self.log_scroll = (self.log_scroll + 20).min(self.log_content.len().saturating_sub(1));
                self.log_auto_follow = false;
            }
            KeyCode::PageUp => {
                self.log_scroll = self.log_scroll.saturating_sub(20);
                self.log_auto_follow = false;
            }
            _ => {}
        }
    }

    fn handle_launch_key(&mut self, key: KeyEvent) {
        let focused = self.launch_form.focused;
        match key.code {
            KeyCode::Esc => {
                self.view = View::List;
                self.status_msg.clear();
            }
            KeyCode::Tab | KeyCode::Down => {
                self.launch_form.focused = (focused + 1) % FIELD_COUNT;
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.launch_form.focused = if focused == 0 { FIELD_COUNT - 1 } else { focused - 1 };
            }
            KeyCode::Enter => {
                self.do_launch();
            }
            // Harness picker: space cycles forward; left/right cycle either way.
            KeyCode::Char(' ') if focused == FIELD_HARNESS => {
                self.launch_form.cycle_harness(1);
            }
            KeyCode::Right if focused == FIELD_HARNESS => {
                self.launch_form.cycle_harness(1);
            }
            KeyCode::Left if focused == FIELD_HARNESS => {
                self.launch_form.cycle_harness(-1);
            }
            // Marathon toggle
            KeyCode::Char(' ') if focused == FIELD_MARATHON => {
                let new_val = if self.launch_form.fields[FIELD_MARATHON].value() == "true" { "false" } else { "true" };
                self.launch_form.fields[FIELD_MARATHON].set(new_val);
            }
            _ if focused != FIELD_HARNESS && focused != FIELD_MARATHON => {
                self.launch_form.fields[focused].handle_key(&key);
            }
            _ => {}
        }
    }

    fn handle_presets_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.show_presets = false,
            KeyCode::Up | KeyCode::Char('k') => {
                if self.preset_selected > 0 { self.preset_selected -= 1; }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.preset_selected + 1 < self.presets.len() {
                    self.preset_selected += 1;
                }
            }
            KeyCode::Enter => {
                if let Some(p) = self.presets.get(self.preset_selected).cloned() {
                    self.launch_form.reset();
                    let harness = if p.harness.is_empty() { "claude" } else { p.harness.as_str() };
                    self.launch_form.fields[FIELD_HARNESS].set(harness);
                    self.launch_form.fields[FIELD_PROMPT].set(&p.prompt);
                    self.launch_form.fields[FIELD_MODEL].set(&p.model);
                    self.launch_form.fields[FIELD_DIR].set(&p.dir);
                    self.launch_form.fields[FIELD_MAX_RUNS].set(&p.max_runs.to_string());
                    self.launch_form.fields[FIELD_MARATHON].set(if p.marathon { "true" } else { "false" });
                    self.launch_form.focused = FIELD_MODEL;
                    self.show_presets = false;
                    self.view = View::Launch;
                    self.status_msg.clear();
                }
            }
            _ => {}
        }
    }

    fn handle_restart_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.view = View::List;
                self.status_msg.clear();
            }
            KeyCode::Enter => {
                self.do_restart();
            }
            KeyCode::Char(c) if c.is_ascii_digit() => {
                if self.restart_form.max_runs.value() == "0" {
                    self.restart_form.max_runs.set(&c.to_string());
                } else {
                    self.restart_form.max_runs.insert_char(c);
                }
            }
            KeyCode::Backspace => {
                self.restart_form.max_runs.backspace();
                if self.restart_form.max_runs.value().is_empty() {
                    self.restart_form.max_runs.set("0");
                }
            }
            KeyCode::Left => { self.restart_form.max_runs.move_left(); }
            KeyCode::Right => { self.restart_form.max_runs.move_right(); }
            KeyCode::Home => { self.restart_form.max_runs.move_home(); }
            KeyCode::End => { self.restart_form.max_runs.move_end(); }
            KeyCode::Delete => { self.restart_form.max_runs.delete(); }
            _ => {}
        }
    }

    fn do_restart(&mut self) {
        let max_runs: u32 = self.restart_form.max_runs.value().parse().unwrap_or(0);
        let name = self.restart_form.instance_name.clone();
        match ralph::restart_instance(&name, max_runs) {
            Ok(msg) => self.status_msg = msg,
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
        self.view = View::List;
        self.refresh_instances();
    }
}
