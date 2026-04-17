mod app;
mod event;
mod ralph;
mod terminal;
mod theme;
mod ui;

use anyhow::Result;
use crossterm::ExecutableCommand;
use crossterm::event::KeyEventKind;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use std::io;
use std::time::Duration;

use app::{App, ExternalAction};
use event::{AppEvent, EventHandler};

fn main() -> Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    stdout.execute(EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let app_result = run(&mut terminal);

    // Restore terminal
    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    if let Err(e) = app_result {
        eprintln!("Error: {}", e);
    }

    Ok(())
}

fn run(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    let mut app = App::new();
    let events = EventHandler::new(Duration::from_millis(500));

    loop {
        if let Ok(area) = terminal.size() {
            let (cols, rows) = popup_inner_size(area.width, area.height);
            app.resize_native_terminal(cols, rows);
        }
        terminal.draw(|frame| ui::render(frame, &mut app))?;

        match events.next()? {
            AppEvent::Key(key) => {
                // Only handle key press events (not release/repeat)
                if key.kind == KeyEventKind::Press {
                    app.handle_key(key);
                }
            }
            AppEvent::Tick => app.on_tick(),
        }

        if let Some(action) = app.take_external_action() {
            let (cols, rows) = terminal
                .size()
                .map(|area| popup_inner_size(area.width, area.height))
                .unwrap_or((100, 30));
            handle_external_action(&mut app, action, cols, rows)?;
        }

        if app.should_quit {
            break;
        }
    }

    Ok(())
}

fn handle_external_action(
    app: &mut App,
    action: ExternalAction,
    cols: u16,
    rows: u16,
) -> Result<()> {
    match action {
        ExternalAction::OpenTerminal { cwd } => match ralph::open_tmux_split(&cwd) {
            Ok(true) => {
                app.status_msg = format!("Opened side pane in {}", cwd);
            }
            Ok(false) => {
                app.status_msg = "Open a tmux session first (tmux new -As ralph).".to_string();
            }
            Err(e) => {
                app.status_msg = format!("Error: {}", e);
            }
        },
        ExternalAction::OpenNativeTerminal { cwd } => {
            app.open_native_terminal(&cwd, cols, rows);
        }
    }
    Ok(())
}

fn popup_inner_size(frame_width: u16, frame_height: u16) -> (u16, u16) {
    let popup_width = (frame_width.saturating_mul(85) / 100).max(20);
    let popup_height = (frame_height.saturating_mul(85) / 100).max(8);
    let cols = popup_width.saturating_sub(2).max(2);
    let rows = popup_height.saturating_sub(4).max(2);
    (cols, rows)
}
