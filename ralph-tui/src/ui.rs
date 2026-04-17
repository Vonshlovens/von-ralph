use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table, TableState, Wrap};

use crate::app::{App, TextInput, View};
use crate::theme::Theme;

/// Render a TextInput as a Line with a visible block cursor
fn render_input_line<'a>(input: &'a TextInput, focused: bool) -> Line<'a> {
    let text = input.value();
    let cursor = input.cursor;
    let chars: Vec<char> = text.chars().collect();

    if !focused {
        return Line::from(format!(" {}", text));
    }

    let (before, cursor_ch, after) = if cursor < chars.len() {
        let before: String = chars[..cursor].iter().collect();
        let cursor_ch = chars[cursor].to_string();
        let after: String = chars[cursor + 1..].iter().collect();
        (before, cursor_ch, after)
    } else {
        (text.to_string(), " ".to_string(), String::new())
    };

    let cursor_style = Style::default().bg(Theme::FG_STRONG).fg(Theme::BG_BASE);

    Line::from(vec![
        Span::raw(format!(" {}", before)),
        Span::styled(cursor_ch, cursor_style),
        Span::raw(after),
    ])
}

fn panel_block(title: &str) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Theme::BORDER_DEFAULT))
        .style(
            Style::default()
                .bg(Theme::BG_ELEVATED)
                .fg(Theme::FG_PRIMARY),
        )
        .title(format!(" {} ", title))
}

fn focused_panel_block(title: &str) -> Block<'static> {
    panel_block(title).border_style(Style::default().fg(Theme::BORDER_FOCUSED))
}

fn title_badge(label: &str) -> Span<'static> {
    Span::styled(
        format!(" {} ", label),
        Style::default()
            .fg(Theme::BG_BASE)
            .bg(Theme::STATE_ACCENT)
            .add_modifier(Modifier::BOLD),
    )
}

fn key_hint(label: &str) -> Span<'static> {
    Span::styled(label.to_string(), Style::default().fg(Theme::STATE_INFO))
}

pub fn render(frame: &mut Frame, app: &mut App) {
    frame.render_widget(
        Block::default().style(Style::default().bg(Theme::BG_BASE).fg(Theme::FG_PRIMARY)),
        frame.area(),
    );

    match app.view {
        View::List => render_list(frame, app),
        View::Log => render_log(frame, app),
        View::Launch => render_launch(frame, app),
        View::Restart => {
            render_list(frame, app);
            render_restart(frame, app);
        }
        View::Inject => {
            match app.inject_return_view {
                View::Log => render_log(frame, app),
                _ => render_list(frame, app),
            }
            render_inject(frame, app);
        }
        View::Terminal => {
            match app.terminal_return_view {
                View::Log => render_log(frame, app),
                _ => render_list(frame, app),
            }
            render_terminal_popup(frame, app);
        }
    }
    if app.show_presets {
        render_presets_popup(frame, app);
    }
}

fn render_list(frame: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Min(5),    // table
            Constraint::Length(4), // prompt preview
            Constraint::Length(1), // status/keybinds
        ])
        .split(frame.area());

    // Title bar
    let title = Line::from(vec![
        title_badge("RALPH TUI"),
        Span::raw(format!(
            "  {} instance{}",
            app.instances.len(),
            if app.instances.len() == 1 { "" } else { "s" }
        )),
    ]);
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Instance table
    let header = Row::new(vec![
        Cell::from(" Status"),
        Cell::from("Name"),
        Cell::from("CLI/Model"),
        Cell::from("Run"),
        Cell::from("Dir"),
        Cell::from("Started"),
    ])
    .style(
        Style::default()
            .fg(Theme::FG_STRONG)
            .add_modifier(Modifier::BOLD),
    )
    .height(1);

    let rows: Vec<Row> = app
        .instances
        .iter()
        .map(|inst| {
            let status = if inst.alive {
                Cell::from(" alive").style(Style::default().fg(Theme::STATE_OK))
            } else {
                Cell::from(" dead").style(Style::default().fg(Theme::STATE_ERROR))
            };
            let run = if inst.max_runs > 0 {
                format!("{}/{}", inst.current_run, inst.max_runs)
            } else if inst.current_run > 0 {
                format!("{}", inst.current_run)
            } else {
                "-".to_string()
            };
            let dir = inst.work_dir.replace(
                dirs::home_dir().unwrap_or_default().to_str().unwrap_or(""),
                "~",
            );
            let started = if inst.started.len() > 19 {
                inst.started[..19].to_string()
            } else {
                inst.started.clone()
            };
            Row::new(vec![
                status,
                Cell::from(inst.name.clone()),
                Cell::from(format!("{}/{}", inst.cli, inst.model)),
                Cell::from(run),
                Cell::from(dir),
                Cell::from(started),
            ])
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(8),
            Constraint::Min(20),
            Constraint::Length(18),
            Constraint::Length(8),
            Constraint::Min(15),
            Constraint::Length(20),
        ],
    )
    .header(header)
    .block(focused_panel_block("Instances"))
    .row_highlight_style(
        Style::default()
            .bg(Theme::STATE_ACCENT)
            .fg(Theme::BG_BASE)
            .add_modifier(Modifier::BOLD),
    )
    .highlight_symbol("▸ ");

    let mut state = TableState::default();
    if !app.instances.is_empty() {
        state.select(Some(app.selected));
    }
    frame.render_stateful_widget(table, chunks[1], &mut state);

    // Prompt preview
    let prompt_text = app
        .selected_instance()
        .map(|i| i.prompt.clone())
        .unwrap_or_else(|| "(no instance selected)".to_string());
    let prompt = Paragraph::new(prompt_text)
        .block(panel_block("Prompt"))
        .wrap(Wrap { trim: true });
    frame.render_widget(prompt, chunks[2]);

    // Status/keybind bar
    let bar = if !app.status_msg.is_empty() {
        Line::from(vec![Span::styled(
            format!(" {} ", app.status_msg),
            Style::default().fg(Theme::STATE_WARN),
        )])
    } else {
        Line::from(vec![
            key_hint(" Enter"),
            Span::raw(" log  "),
            key_hint("K"),
            Span::raw(" kill  "),
            key_hint("i"),
            Span::raw(" inject  "),
            key_hint("t"),
            Span::raw(" split  "),
            key_hint("T"),
            Span::raw(" native  "),
            key_hint("p"),
            Span::raw(" presets  "),
            key_hint("n"),
            Span::raw(" new  "),
            key_hint("R"),
            Span::raw(" restart  "),
            key_hint("c"),
            Span::raw(" clean  "),
            key_hint("r"),
            Span::raw(" refresh  "),
            key_hint("q"),
            Span::raw(" quit"),
        ])
    };
    frame.render_widget(
        Paragraph::new(bar).style(Style::default().fg(Theme::FG_MUTED)),
        chunks[3],
    );
}

fn render_log(frame: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Min(3),    // log content
            Constraint::Length(1), // keybinds
        ])
        .split(frame.area());

    // Title
    let follow_indicator = if app.log_auto_follow {
        " [auto-follow]"
    } else {
        ""
    };
    let title = Line::from(vec![
        title_badge("LOG"),
        Span::styled(
            format!("{} ", app.log_instance_name),
            Style::default()
                .fg(Theme::BG_BASE)
                .bg(Theme::STATE_ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!(
            " {}/{} lines{}",
            app.log_scroll + 1,
            app.log_content.len(),
            follow_indicator,
        )),
    ]);
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Log content
    let visible_height = chunks[1].height as usize;
    let start = app
        .log_scroll
        .saturating_sub(visible_height.saturating_sub(1));
    let end = app.log_content.len().min(start + visible_height);

    let lines: Vec<Line> = app.log_content[start..end]
        .iter()
        .map(|s| {
            let style = if s.contains("--- RUN") && s.contains("COMPLETE") {
                Style::default().fg(Theme::STATE_OK)
            } else if s.contains("--- RUN") {
                Style::default().fg(Theme::STATE_INFO)
            } else if s.contains("Error") || s.contains("error") || s.contains("FAIL") {
                Style::default().fg(Theme::STATE_ERROR)
            } else if s.starts_with("[") && s.contains("]") {
                Style::default().fg(Theme::FG_MUTED)
            } else {
                Style::default().fg(Theme::FG_PRIMARY)
            };
            Line::from(Span::styled(s.as_str(), style))
        })
        .collect();

    let log_widget = Paragraph::new(lines).block(
        focused_panel_block("Log")
            .style(Style::default().bg(Theme::BG_SUBTLE).fg(Theme::FG_PRIMARY)),
    );
    frame.render_widget(log_widget, chunks[1]);

    // Keybind bar
    let bar = if !app.status_msg.is_empty() {
        Line::from(Span::styled(
            format!(" {} ", app.status_msg),
            Style::default().fg(Theme::STATE_WARN),
        ))
    } else {
        Line::from(vec![
            key_hint(" Esc"),
            Span::raw(" back  "),
            key_hint("j/k"),
            Span::raw(" scroll  "),
            key_hint("g/G"),
            Span::raw(" top/bottom  "),
            key_hint("K"),
            Span::raw(" kill  "),
            key_hint("i"),
            Span::raw(" inject  "),
            key_hint("t"),
            Span::raw(" split  "),
            key_hint("T"),
            Span::raw(" native  "),
            key_hint("PgUp/PgDn"),
            Span::raw(" page"),
        ])
    };
    frame.render_widget(
        Paragraph::new(bar).style(Style::default().fg(Theme::FG_MUTED)),
        chunks[2],
    );
}

fn render_launch(frame: &mut Frame, app: &mut App) {
    let full = frame.area();
    // Horizontal margin: center at 80% width, but use full width if terminal is narrow
    let area = if full.width > 60 {
        let margin = (full.width - full.width * 80 / 100) / 2;
        Rect::new(
            full.x + margin,
            full.y,
            full.width - margin * 2,
            full.height,
        )
    } else {
        full
    };
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // [0] title
            Constraint::Length(3), // [1] prompt
            Constraint::Length(3), // [2] cli model
            Constraint::Length(1), // [3] cli model hint
            Constraint::Length(3), // [4] dir
            Constraint::Length(3), // [5] name
            Constraint::Length(3), // [6] max_runs
            Constraint::Length(3), // [7] marathon
            Constraint::Min(0),    // [8] spacer
            Constraint::Length(1), // [9] keybinds
        ])
        .split(area);

    // Title
    let title = Line::from(title_badge("LAUNCH NEW RALPH"));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Form fields — chunk indices: prompt=[1], cli_model=[2], hint=[3], dir=[4], name=[5], max_runs=[6], marathon=[7]
    for i in 0..6 {
        let is_focused = app.launch_form.focused == i;
        let border_style = if is_focused {
            Style::default().fg(Theme::BORDER_FOCUSED)
        } else {
            Style::default().fg(Theme::BORDER_DEFAULT)
        };

        let label = app.launch_form.labels[i];
        let input = &app.launch_form.fields[i];

        let content: Line = if i == 5 {
            // Marathon toggle
            let display = if input.value() == "true" {
                " [x] enabled"
            } else {
                " [ ] disabled"
            };
            Line::from(display)
        } else {
            render_input_line(input, is_focused)
        };

        // Skip hint slot (chunk[3]) when mapping field index to chunk index
        let chunk_idx = if i < 2 { i + 1 } else { i + 2 };
        let widget = Paragraph::new(content).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(border_style)
                .style(
                    Style::default()
                        .bg(Theme::BG_ELEVATED)
                        .fg(Theme::FG_PRIMARY),
                )
                .title(format!(" {} ", label)),
        );
        frame.render_widget(widget, chunks[chunk_idx]);

        // Hint below the CLI Model field
        if i == 1 {
            let hint = Paragraph::new(Line::from(Span::styled(
                "  e.g. \"gemini flash\"",
                Style::default()
                    .fg(Theme::FG_MUTED)
                    .add_modifier(Modifier::ITALIC),
            )));
            frame.render_widget(hint, chunks[3]);
        }
    }

    // Keybind bar
    let bar = Line::from(vec![
        key_hint(" Tab"),
        Span::raw(" next  "),
        key_hint("Enter"),
        Span::raw(" launch  "),
        key_hint("Esc"),
        Span::raw(" cancel"),
    ]);
    frame.render_widget(
        Paragraph::new(bar).style(Style::default().fg(Theme::FG_MUTED)),
        chunks[9],
    );
}

fn render_restart(frame: &mut Frame, app: &mut App) {
    let area = centered_rect(50, 30, frame.area());
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Length(3), // info
            Constraint::Length(3), // max_runs input
            Constraint::Min(0),    // spacer
            Constraint::Length(1), // keybinds
        ])
        .split(area);

    // Title
    let title = Line::from(title_badge("RESTART RALPH"));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Instance info
    let info = Paragraph::new(format!(" Restarting: {}", app.restart_form.instance_name))
        .block(panel_block("Instance"));
    frame.render_widget(info, chunks[1]);

    // Max runs input
    let content = render_input_line(&app.restart_form.max_runs, true);
    let input = Paragraph::new(content).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Theme::BORDER_FOCUSED))
            .style(
                Style::default()
                    .bg(Theme::BG_ELEVATED)
                    .fg(Theme::FG_PRIMARY),
            )
            .title(" Max runs (0 = unlimited) "),
    );
    frame.render_widget(input, chunks[2]);

    // Keybind bar
    let bar = Line::from(vec![
        key_hint(" Enter"),
        Span::raw(" restart  "),
        key_hint("Esc"),
        Span::raw(" cancel"),
    ]);
    frame.render_widget(
        Paragraph::new(bar).style(Style::default().fg(Theme::FG_MUTED)),
        chunks[4],
    );
}

fn render_inject(frame: &mut Frame, app: &mut App) {
    let area = centered_rect(70, 35, frame.area());
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Length(3), // instance
            Constraint::Length(3), // prompt
            Constraint::Length(2), // hint/status
            Constraint::Min(0),    // spacer
            Constraint::Length(1), // keybinds
        ])
        .split(area);

    let title = Line::from(title_badge("PROMPT INJECTION"));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    let instance = Paragraph::new(format!(" {}", app.inject_form.instance_name))
        .block(panel_block("Instance"));
    frame.render_widget(instance, chunks[1]);

    let prompt = Paragraph::new(render_input_line(&app.inject_form.prompt, true)).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Theme::BORDER_FOCUSED))
            .style(
                Style::default()
                    .bg(Theme::BG_ELEVATED)
                    .fg(Theme::FG_PRIMARY),
            )
            .title(" Message "),
    );
    frame.render_widget(prompt, chunks[2]);

    let hint_text = if app.status_msg.is_empty() {
        "  Delivered between loop iterations"
    } else {
        app.status_msg.as_str()
    };
    let hint_style = if app.status_msg.is_empty() {
        Style::default()
            .fg(Theme::FG_MUTED)
            .add_modifier(Modifier::ITALIC)
    } else {
        Style::default().fg(Theme::STATE_WARN)
    };
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(hint_text, hint_style))).wrap(Wrap { trim: true }),
        chunks[3],
    );

    let bar = Line::from(vec![
        key_hint(" Enter"),
        Span::raw(" send  "),
        key_hint("Esc"),
        Span::raw(" cancel"),
    ]);
    frame.render_widget(
        Paragraph::new(bar).style(Style::default().fg(Theme::FG_MUTED)),
        chunks[5],
    );
}

fn render_terminal_popup(frame: &mut Frame, app: &App) {
    let area = centered_rect(85, 85, frame.area());
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Min(3),    // terminal
            Constraint::Length(1), // keybinds
        ])
        .split(area);

    let cwd = app
        .native_terminal
        .as_ref()
        .map(|t| t.cwd().to_string())
        .unwrap_or_else(|| "".to_string());
    let title = Line::from(vec![
        title_badge("TERMINAL"),
        Span::raw(format!(" {}", cwd)),
    ]);
    frame.render_widget(Paragraph::new(title), chunks[0]);

    let contents = app
        .native_terminal
        .as_ref()
        .map(|t| t.screen_contents())
        .unwrap_or_else(|| "terminal unavailable".to_string());

    let term = Paragraph::new(contents).block(
        focused_panel_block("Shell")
            .style(Style::default().bg(Theme::BG_SUBTLE).fg(Theme::FG_PRIMARY)),
    );
    frame.render_widget(term, chunks[1]);

    let bar = Line::from(vec![
        key_hint(" Ctrl-G"),
        Span::raw(" close  "),
        key_hint("Ctrl-C"),
        Span::raw(" interrupt shell"),
    ]);
    frame.render_widget(
        Paragraph::new(bar).style(Style::default().fg(Theme::FG_MUTED)),
        chunks[2],
    );
}

fn render_presets_popup(frame: &mut Frame, app: &App) {
    let area = centered_rect(65, 55, frame.area());
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Min(3),    // preset list
            Constraint::Length(4), // description
            Constraint::Length(1), // keybinds
        ])
        .split(area);

    let title = Line::from(title_badge("SKILL PRESETS"));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Preset list
    let rows: Vec<Row> = app
        .presets
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let style = if i == app.preset_selected {
                Style::default()
                    .bg(Theme::STATE_ACCENT)
                    .fg(Theme::BG_BASE)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Theme::FG_PRIMARY)
            };
            let prefix = if i == app.preset_selected {
                "▸ "
            } else {
                "  "
            };
            Row::new(vec![Cell::from(format!("{}{}", prefix, p.name))]).style(style)
        })
        .collect();

    let list =
        Table::new(rows, [Constraint::Percentage(100)]).block(focused_panel_block("Presets"));
    frame.render_widget(list, chunks[1]);

    // Description of selected preset
    let desc = app
        .presets
        .get(app.preset_selected)
        .map(|p| p.description.as_str())
        .unwrap_or("");
    let description = Paragraph::new(desc)
        .block(panel_block("Description"))
        .wrap(Wrap { trim: true });
    frame.render_widget(description, chunks[2]);

    // Keybind bar
    let bar = Line::from(vec![
        key_hint(" j/k"),
        Span::raw(" select  "),
        key_hint("Enter"),
        Span::raw(" load  "),
        key_hint("Esc"),
        Span::raw(" cancel"),
    ]);
    frame.render_widget(
        Paragraph::new(bar).style(Style::default().fg(Theme::FG_MUTED)),
        chunks[3],
    );
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}
