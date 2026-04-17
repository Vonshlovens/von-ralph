use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table, TableState, Wrap};

use crate::app::{App, TextInput, View};

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

    let cursor_style = Style::default().bg(Color::White).fg(Color::Black);

    Line::from(vec![
        Span::raw(format!(" {}", before)),
        Span::styled(cursor_ch, cursor_style),
        Span::raw(after),
    ])
}

pub fn render(frame: &mut Frame, app: &mut App) {
    match app.view {
        View::List => render_list(frame, app),
        View::Log => render_log(frame, app),
        View::Launch => render_launch(frame, app),
        View::Restart => {
            render_list(frame, app);
            render_restart(frame, app);
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
            Constraint::Length(1),  // title
            Constraint::Min(5),    // table
            Constraint::Length(4), // prompt preview
            Constraint::Length(1), // status/keybinds
        ])
        .split(frame.area());

    // Title bar
    let title = Line::from(vec![
        Span::styled(" RALPH TUI ", Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw(format!("  {} instance{}", app.instances.len(), if app.instances.len() == 1 { "" } else { "s" })),
    ]);
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Instance table
    let header = Row::new(vec![
        Cell::from(" Status"),
        Cell::from("Name"),
        Cell::from("Model"),
        Cell::from("Run"),
        Cell::from("Dir"),
        Cell::from("Started"),
    ])
    .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
    .height(1);

    let rows: Vec<Row> = app
        .instances
        .iter()
        .map(|inst| {
            let status = if inst.alive {
                Cell::from(" alive").style(Style::default().fg(Color::Green))
            } else {
                Cell::from(" dead").style(Style::default().fg(Color::Red))
            };
            let run = if inst.max_runs > 0 {
                format!("{}/{}", inst.current_run, inst.max_runs)
            } else if inst.current_run > 0 {
                format!("{}", inst.current_run)
            } else {
                "-".to_string()
            };
            let dir = inst
                .work_dir
                .replace(dirs::home_dir().unwrap_or_default().to_str().unwrap_or(""), "~");
            let started = if inst.started.len() > 19 {
                inst.started[..19].to_string()
            } else {
                inst.started.clone()
            };
            Row::new(vec![
                status,
                Cell::from(inst.name.clone()),
                Cell::from(inst.model.clone()),
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
            Constraint::Length(8),
            Constraint::Length(8),
            Constraint::Min(15),
            Constraint::Length(20),
        ],
    )
    .header(header)
    .block(Block::default().borders(Borders::ALL).title(" Instances "))
    .row_highlight_style(Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD))
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
        .block(Block::default().borders(Borders::ALL).title(" Prompt "))
        .wrap(Wrap { trim: true });
    frame.render_widget(prompt, chunks[2]);

    // Status/keybind bar
    let bar = if !app.status_msg.is_empty() {
        Line::from(vec![
            Span::styled(format!(" {} ", app.status_msg), Style::default().fg(Color::Yellow)),
        ])
    } else {
        Line::from(vec![
            Span::styled(" Enter", Style::default().fg(Color::Cyan)),
            Span::raw(" log  "),
            Span::styled("K", Style::default().fg(Color::Cyan)),
            Span::raw(" kill  "),
            Span::styled("p", Style::default().fg(Color::Cyan)),
            Span::raw(" presets  "),
            Span::styled("n", Style::default().fg(Color::Cyan)),
            Span::raw(" new  "),
            Span::styled("R", Style::default().fg(Color::Cyan)),
            Span::raw(" restart  "),
            Span::styled("c", Style::default().fg(Color::Cyan)),
            Span::raw(" clean  "),
            Span::styled("r", Style::default().fg(Color::Cyan)),
            Span::raw(" refresh  "),
            Span::styled("q", Style::default().fg(Color::Cyan)),
            Span::raw(" quit"),
        ])
    };
    frame.render_widget(Paragraph::new(bar), chunks[3]);
}

fn render_log(frame: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Min(3),   // log content
            Constraint::Length(1), // keybinds
        ])
        .split(frame.area());

    // Title
    let follow_indicator = if app.log_auto_follow { " [auto-follow]" } else { "" };
    let title = Line::from(vec![
        Span::styled(" LOG: ", Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::styled(
            format!("{} ", app.log_instance_name),
            Style::default().fg(Color::Black).bg(Color::Cyan),
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
    let start = app.log_scroll.saturating_sub(visible_height.saturating_sub(1));
    let end = app.log_content.len().min(start + visible_height);

    let lines: Vec<Line> = app.log_content[start..end]
        .iter()
        .map(|s| {
            let style = if s.contains("--- RUN") && s.contains("COMPLETE") {
                Style::default().fg(Color::Green)
            } else if s.contains("--- RUN") {
                Style::default().fg(Color::Cyan)
            } else if s.contains("Error") || s.contains("error") || s.contains("FAIL") {
                Style::default().fg(Color::Red)
            } else if s.starts_with("[") && s.contains("]") {
                Style::default().fg(Color::DarkGray)
            } else {
                Style::default()
            };
            Line::from(Span::styled(s.as_str(), style))
        })
        .collect();

    let log_widget = Paragraph::new(lines)
        .block(Block::default().borders(Borders::ALL));
    frame.render_widget(log_widget, chunks[1]);

    // Keybind bar
    let bar = if !app.status_msg.is_empty() {
        Line::from(Span::styled(
            format!(" {} ", app.status_msg),
            Style::default().fg(Color::Yellow),
        ))
    } else {
        Line::from(vec![
            Span::styled(" Esc", Style::default().fg(Color::Cyan)),
            Span::raw(" back  "),
            Span::styled("j/k", Style::default().fg(Color::Cyan)),
            Span::raw(" scroll  "),
            Span::styled("g/G", Style::default().fg(Color::Cyan)),
            Span::raw(" top/bottom  "),
            Span::styled("K", Style::default().fg(Color::Cyan)),
            Span::raw(" kill  "),
            Span::styled("PgUp/PgDn", Style::default().fg(Color::Cyan)),
            Span::raw(" page"),
        ])
    };
    frame.render_widget(Paragraph::new(bar), chunks[2]);
}

fn render_launch(frame: &mut Frame, app: &mut App) {
    let full = frame.area();
    // Horizontal margin: center at 80% width, but use full width if terminal is narrow
    let area = if full.width > 60 {
        let margin = (full.width - full.width * 80 / 100) / 2;
        Rect::new(full.x + margin, full.y, full.width - margin * 2, full.height)
    } else {
        full
    };
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Length(3), // prompt
            Constraint::Length(3), // model
            Constraint::Length(3), // dir
            Constraint::Length(3), // name
            Constraint::Length(3), // max_runs
            Constraint::Length(3), // marathon
            Constraint::Min(0),   // spacer
            Constraint::Length(1), // keybinds
        ])
        .split(area);

    // Title
    let title = Line::from(Span::styled(
        " LAUNCH NEW RALPH ",
        Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Form fields
    for i in 0..6 {
        let is_focused = app.launch_form.focused == i;
        let border_style = if is_focused {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let label = app.launch_form.labels[i];
        let input = &app.launch_form.fields[i];

        let content: Line = if i == 5 {
            // Marathon toggle
            let display = if input.value() == "true" { " [x] enabled" } else { " [ ] disabled" };
            Line::from(display)
        } else {
            render_input_line(input, is_focused)
        };

        let field_area = chunks[i + 1];
        let widget = Paragraph::new(content)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(border_style)
                    .title(format!(" {} ", label)),
            );
        frame.render_widget(widget, field_area);
    }

    // Keybind bar
    let bar = Line::from(vec![
        Span::styled(" Tab", Style::default().fg(Color::Cyan)),
        Span::raw(" next  "),
        Span::styled("Enter", Style::default().fg(Color::Cyan)),
        Span::raw(" launch  "),
        Span::styled("Esc", Style::default().fg(Color::Cyan)),
        Span::raw(" cancel"),
    ]);
    frame.render_widget(Paragraph::new(bar), chunks[8]);
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
            Constraint::Min(0),   // spacer
            Constraint::Length(1), // keybinds
        ])
        .split(area);

    // Title
    let title = Line::from(Span::styled(
        " RESTART RALPH ",
        Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Instance info
    let info = Paragraph::new(format!(" Restarting: {}", app.restart_form.instance_name))
        .block(Block::default().borders(Borders::ALL).title(" Instance "));
    frame.render_widget(info, chunks[1]);

    // Max runs input
    let content = render_input_line(&app.restart_form.max_runs, true);
    let input = Paragraph::new(content)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .title(" Max runs (0 = unlimited) "),
        );
    frame.render_widget(input, chunks[2]);

    // Keybind bar
    let bar = Line::from(vec![
        Span::styled(" Enter", Style::default().fg(Color::Cyan)),
        Span::raw(" restart  "),
        Span::styled("Esc", Style::default().fg(Color::Cyan)),
        Span::raw(" cancel"),
    ]);
    frame.render_widget(Paragraph::new(bar), chunks[4]);
}

fn render_presets_popup(frame: &mut Frame, app: &App) {
    let area = centered_rect(65, 55, frame.area());
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),  // title
            Constraint::Min(3),     // preset list
            Constraint::Length(4),  // description
            Constraint::Length(1),  // keybinds
        ])
        .split(area);

    let title = Line::from(Span::styled(
        " SKILL PRESETS ",
        Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Preset list
    let rows: Vec<Row> = app.presets.iter().enumerate().map(|(i, p)| {
        let style = if i == app.preset_selected {
            Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let prefix = if i == app.preset_selected { "▸ " } else { "  " };
        Row::new(vec![Cell::from(format!("{}{}", prefix, p.name))]).style(style)
    }).collect();

    let list = Table::new(rows, [Constraint::Percentage(100)])
        .block(Block::default().borders(Borders::ALL).title(" Presets "));
    frame.render_widget(list, chunks[1]);

    // Description of selected preset
    let desc = app.presets.get(app.preset_selected)
        .map(|p| p.description.as_str())
        .unwrap_or("");
    let description = Paragraph::new(desc)
        .block(Block::default().borders(Borders::ALL).title(" Description "))
        .wrap(Wrap { trim: true });
    frame.render_widget(description, chunks[2]);

    // Keybind bar
    let bar = Line::from(vec![
        Span::styled(" j/k", Style::default().fg(Color::Cyan)),
        Span::raw(" select  "),
        Span::styled("Enter", Style::default().fg(Color::Cyan)),
        Span::raw(" load  "),
        Span::styled("Esc", Style::default().fg(Color::Cyan)),
        Span::raw(" cancel"),
    ]);
    frame.render_widget(Paragraph::new(bar), chunks[3]);
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
