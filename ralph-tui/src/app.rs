use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::time::Instant;

use crate::ralph::{self, RalphInstance, RalphPreset, SpawnOpts};

#[derive(Clone, Copy, PartialEq)]
pub enum View {
    List,
    Log,
    Launch,
    Restart,
    Inject,
}

pub struct TextInput {
    pub text: String,
    pub cursor: usize, // character position (not byte)
}

impl TextInput {
    pub fn new(text: &str) -> Self {
        let cursor = text.chars().count();
        Self {
            text: text.to_string(),
            cursor,
        }
    }

    pub fn empty() -> Self {
        Self {
            text: String::new(),
            cursor: 0,
        }
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
        self.text
            .char_indices()
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
            KeyCode::Char(c) => {
                self.insert_char(c);
                true
            }
            KeyCode::Backspace => {
                self.backspace();
                true
            }
            KeyCode::Delete => {
                self.delete();
                true
            }
            KeyCode::Left => {
                self.move_left();
                true
            }
            KeyCode::Right => {
                self.move_right();
                true
            }
            KeyCode::Home => {
                self.move_home();
                true
            }
            KeyCode::End => {
                self.move_end();
                true
            }
            _ => false,
        }
    }
}

pub struct LaunchForm {
    pub fields: [TextInput; 6], // prompt, model, dir, name, max_runs, marathon
    pub focused: usize,
    pub labels: [&'static str; 6],
}

impl LaunchForm {
    pub fn new() -> Self {
        let dir = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        Self {
            fields: [
                TextInput::empty(),            // prompt
                TextInput::new("claude opus"), // cli + model
                TextInput::new(&dir),          // dir
                TextInput::empty(),            // name
                TextInput::new("0"),           // max_runs
                TextInput::new("false"),       // marathon
            ],
            focused: 0,
            labels: [
                "Prompt",
                "CLI  Model",
                "Directory",
                "Name",
                "Max runs",
                "Marathon",
            ],
        }
    }

    pub fn reset(&mut self) {
        self.fields[0].clear();
        self.fields[1].set("claude opus");
        let dir = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        self.fields[2].set(&dir);
        self.fields[3].clear();
        self.fields[4].set("0");
        self.fields[5].set("false");
        self.focused = 0;
    }
}

pub struct RestartForm {
    pub instance_name: String,
    pub max_runs: TextInput,
}

pub struct InjectForm {
    pub instance_name: String,
    pub prompt: TextInput,
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
    pub inject_form: InjectForm,
    pub inject_return_view: View,
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
            restart_form: RestartForm {
                instance_name: String::new(),
                max_runs: TextInput::new("0"),
            },
            inject_form: InjectForm {
                instance_name: String::new(),
                prompt: TextInput::empty(),
            },
            inject_return_view: View::List,
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
            View::Launch | View::Restart | View::Inject => {}
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
        if let Some(inst) = self
            .instances
            .iter()
            .find(|i| i.name == self.log_instance_name)
        {
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
        let raw_cli_model = self.launch_form.fields[1].value().to_string();
        let resolved = ralph::harness::resolve(&raw_cli_model);
        self.launch_form.fields[1].set(&format!("{} {}", resolved.cli, resolved.model));
        let opts = SpawnOpts {
            prompt: self.launch_form.fields[0].value().to_string(),
            model: resolved.model,
            cli: resolved.cli,
            dir: self.launch_form.fields[2].value().to_string(),
            name: self.launch_form.fields[3].value().to_string(),
            max_runs: self.launch_form.fields[4].value().parse().unwrap_or(0),
            marathon: self.launch_form.fields[5].value() == "true",
        };
        match ralph::spawn_ralph(&opts) {
            Ok(msg) => self.status_msg = msg,
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
        self.launch_form.reset();
        self.view = View::List;
        self.refresh_instances();
    }

    fn open_inject_for(&mut self, name: String, return_view: View) {
        let Some(inst) = self.instances.iter().find(|i| i.name == name) else {
            self.status_msg = format!("No ralph named {}", name);
            return;
        };
        if !inst.alive {
            self.status_msg = format!("{} is not running", inst.name);
            return;
        }

        self.inject_form.instance_name = inst.name.clone();
        self.inject_form.prompt.clear();
        self.inject_return_view = return_view;
        self.view = View::Inject;
        self.status_msg.clear();
        self.confirm_kill = None;
    }

    fn open_inject_for_selected(&mut self) {
        if let Some(inst) = self.selected_instance() {
            self.open_inject_for(inst.name.clone(), View::List);
        }
    }

    fn open_inject_for_log(&mut self) {
        self.refresh_instances();
        self.open_inject_for(self.log_instance_name.clone(), View::Log);
    }

    fn cancel_inject(&mut self) {
        self.inject_form.prompt.clear();
        self.view = self.inject_return_view;
        self.status_msg.clear();
    }

    fn do_inject(&mut self) {
        let name = self.inject_form.instance_name.clone();
        let prompt = self.inject_form.prompt.value().to_string();
        match ralph::inject_prompt(&name, &prompt) {
            Ok(msg) => {
                self.status_msg = msg;
                self.inject_form.prompt.clear();
                self.view = self.inject_return_view;
                self.refresh_instances();
            }
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
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
            View::Inject => self.handle_inject_key(key),
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
            KeyCode::Char('i') => {
                self.open_inject_for_selected();
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
                self.log_scroll =
                    (self.log_scroll + 1).min(self.log_content.len().saturating_sub(1));
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
            KeyCode::Char('i') => {
                self.open_inject_for_log();
            }
            KeyCode::PageDown => {
                self.log_scroll =
                    (self.log_scroll + 20).min(self.log_content.len().saturating_sub(1));
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
                self.launch_form.focused = (focused + 1) % 6;
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.launch_form.focused = if focused == 0 { 5 } else { focused - 1 };
            }
            KeyCode::Enter => {
                self.do_launch();
            }
            KeyCode::Char(' ') if focused == 5 => {
                // Toggle marathon
                let new_val = if self.launch_form.fields[5].value() == "true" {
                    "false"
                } else {
                    "true"
                };
                self.launch_form.fields[5].set(new_val);
            }
            _ if focused != 5 => {
                self.launch_form.fields[focused].handle_key(&key);
            }
            _ => {}
        }
    }

    fn handle_presets_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.show_presets = false,
            KeyCode::Up | KeyCode::Char('k') => {
                if self.preset_selected > 0 {
                    self.preset_selected -= 1;
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.preset_selected + 1 < self.presets.len() {
                    self.preset_selected += 1;
                }
            }
            KeyCode::Enter => {
                if let Some(p) = self.presets.get(self.preset_selected).cloned() {
                    self.launch_form.reset();
                    self.launch_form.fields[0].set(&p.prompt);
                    self.launch_form.fields[1].set(&p.model);
                    if !p.dir.is_empty() {
                        self.launch_form.fields[2].set(&p.dir);
                    }
                    self.launch_form.fields[4].set(&p.max_runs.to_string());
                    self.launch_form.fields[5].set(if p.marathon { "true" } else { "false" });
                    self.launch_form.focused = 1; // land on Model so user can Tab → Max runs
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
            KeyCode::Left => {
                self.restart_form.max_runs.move_left();
            }
            KeyCode::Right => {
                self.restart_form.max_runs.move_right();
            }
            KeyCode::Home => {
                self.restart_form.max_runs.move_home();
            }
            KeyCode::End => {
                self.restart_form.max_runs.move_end();
            }
            KeyCode::Delete => {
                self.restart_form.max_runs.delete();
            }
            _ => {}
        }
    }

    fn handle_inject_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.cancel_inject();
            }
            KeyCode::Enter => {
                self.do_inject();
            }
            _ => {
                self.inject_form.prompt.handle_key(&key);
            }
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
