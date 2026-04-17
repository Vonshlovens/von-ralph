use ratatui::style::Color;

pub struct Theme;

impl Theme {
    pub const BG_BASE: Color = Color::Rgb(0x18, 0x18, 0x18);
    pub const BG_ELEVATED: Color = Color::Rgb(0x1f, 0x1f, 0x1f);
    pub const BG_SUBTLE: Color = Color::Rgb(0x0f, 0x0f, 0x0f);

    pub const FG_PRIMARY: Color = Color::Rgb(0xd8, 0xd8, 0xd8);
    pub const FG_MUTED: Color = Color::Rgb(0x82, 0x84, 0x82);
    pub const FG_STRONG: Color = Color::Rgb(0xf8, 0xf8, 0xf8);

    pub const BORDER_DEFAULT: Color = Color::Rgb(0x6b, 0x6b, 0x6b);
    pub const BORDER_FOCUSED: Color = Color::Rgb(0x82, 0xb8, 0xc8);

    pub const STATE_OK: Color = Color::Rgb(0x90, 0xa9, 0x59);
    pub const STATE_WARN: Color = Color::Rgb(0xf4, 0xbf, 0x75);
    pub const STATE_ERROR: Color = Color::Rgb(0xac, 0x42, 0x42);
    pub const STATE_INFO: Color = Color::Rgb(0x75, 0xb5, 0xaa);
    pub const STATE_ACCENT: Color = Color::Rgb(0x6a, 0x9f, 0xb5);
}
