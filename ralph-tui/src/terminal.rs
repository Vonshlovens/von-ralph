use anyhow::{Context, Result};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub struct NativeTerminal {
    cwd: String,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
    writer: Box<dyn Write + Send>,
    parser: vt100::Parser,
    rx: mpsc::Receiver<Vec<u8>>,
    _reader_thread: thread::JoinHandle<()>,
}

impl NativeTerminal {
    pub fn spawn(cwd: &str, cols: u16, rows: u16) -> Result<Self> {
        let working_dir = if cwd.trim().is_empty() {
            std::env::current_dir().unwrap_or_default()
        } else {
            PathBuf::from(cwd)
        };
        if !working_dir.exists() {
            anyhow::bail!(
                "working directory does not exist: {}",
                working_dir.display()
            );
        }

        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to open PTY pair")?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(working_dir.clone());

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("Failed to spawn shell in PTY")?;
        let writer = pair
            .master
            .take_writer()
            .context("Failed to open PTY writer")?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("Failed to open PTY reader")?;

        let (tx, rx) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        if err.kind() == std::io::ErrorKind::Interrupted {
                            continue;
                        }
                        break;
                    }
                }
            }
        });

        Ok(Self {
            cwd: working_dir.to_string_lossy().to_string(),
            master: pair.master,
            child,
            writer,
            parser: vt100::Parser::new(rows.max(2), cols.max(2), 0),
            rx,
            _reader_thread: reader_thread,
        })
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn drain_output(&mut self) {
        while let Ok(chunk) = self.rx.try_recv() {
            self.parser.process(&chunk);
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        self.master.resize(size).context("Failed to resize PTY")?;
        self.parser.set_size(rows.max(2), cols.max(2));
        Ok(())
    }

    pub fn send_key(&mut self, key: KeyEvent) -> Result<bool> {
        let Some(bytes) = encode_key(key) else {
            return Ok(false);
        };
        self.writer
            .write_all(&bytes)
            .context("Failed to write key to PTY")?;
        self.writer.flush().ok();
        Ok(true)
    }

    pub fn screen_contents(&self) -> String {
        self.parser.screen().contents()
    }

    pub fn has_exited(&mut self) -> Result<bool> {
        let exited = self
            .child
            .try_wait()
            .context("Failed to poll PTY child status")?;
        Ok(exited.is_some())
    }

    pub fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        thread::sleep(Duration::from_millis(20));
    }
}

impl Drop for NativeTerminal {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn encode_key(key: KeyEvent) -> Option<Vec<u8>> {
    let mut out = Vec::new();

    if key.modifiers.contains(KeyModifiers::ALT) {
        out.push(0x1b);
    }

    match key.code {
        KeyCode::Char(c) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                if c.is_ascii() {
                    let ctrl = (c.to_ascii_lowercase() as u8) & 0x1f;
                    out.push(ctrl);
                } else {
                    return None;
                }
            } else {
                let mut buf = [0u8; 4];
                let encoded = c.encode_utf8(&mut buf);
                out.extend_from_slice(encoded.as_bytes());
            }
        }
        KeyCode::Enter => out.push(b'\r'),
        KeyCode::Tab => out.push(b'\t'),
        KeyCode::BackTab => out.extend_from_slice(b"\x1b[Z"),
        KeyCode::Backspace => out.push(0x7f),
        KeyCode::Esc => out.push(0x1b),
        KeyCode::Left => out.extend_from_slice(b"\x1b[D"),
        KeyCode::Right => out.extend_from_slice(b"\x1b[C"),
        KeyCode::Up => out.extend_from_slice(b"\x1b[A"),
        KeyCode::Down => out.extend_from_slice(b"\x1b[B"),
        KeyCode::Home => out.extend_from_slice(b"\x1b[H"),
        KeyCode::End => out.extend_from_slice(b"\x1b[F"),
        KeyCode::Delete => out.extend_from_slice(b"\x1b[3~"),
        KeyCode::Insert => out.extend_from_slice(b"\x1b[2~"),
        KeyCode::PageUp => out.extend_from_slice(b"\x1b[5~"),
        KeyCode::PageDown => out.extend_from_slice(b"\x1b[6~"),
        _ => return None,
    }

    Some(out)
}
