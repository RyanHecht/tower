import { RGBA, SyntaxStyle } from "@opentui/core";

let cached: SyntaxStyle | null = null;

/**
 * Build a SyntaxStyle for the markdown renderer.
 *
 * `SyntaxStyle.create()` produces an empty palette — every `markup.*` token
 * resolves to default text, which is why bold, italics, headings, and code
 * blocks all looked identical on screen. We register an explicit set of
 * styles that mimic the Copilot CLI's markdown rendering:
 *
 *   - headings: bold, cyan (CLIs can't actually grow font size)
 *   - strong: bold, soft white
 *   - italic: italic, soft white
 *   - inline code (markup.raw): yellow-orange on a faint background
 *   - fenced code blocks (markup.raw.block): same fg, slightly darker bg
 *   - link label: cyan underlined
 *   - link url: dim cyan
 *   - strikethrough: dim with strike
 */
export const getMarkdownStyle = (): SyntaxStyle => {
    if (cached) return cached;

    const SOFT_WHITE = RGBA.fromHex("#d4d4d8");
    const HEADING = RGBA.fromHex("#7dd3fc");          // sky-300
    const CODE_FG = RGBA.fromHex("#fbbf24");          // amber-400
    const CODE_BG = RGBA.fromHex("#1f2937");          // gray-800 (subtle bg)
    const CODE_BLOCK_BG = RGBA.fromHex("#111827");    // gray-900 (a hair darker)
    const LINK = RGBA.fromHex("#67e8f9");             // cyan-300
    const LINK_DIM = RGBA.fromHex("#0e7490");         // cyan-700

    cached = SyntaxStyle.fromStyles({
        default:                { fg: SOFT_WHITE },
        "markup.heading":       { fg: HEADING, bold: true },
        "markup.heading.1":     { fg: HEADING, bold: true, underline: true },
        "markup.heading.2":     { fg: HEADING, bold: true },
        "markup.heading.3":     { fg: HEADING, bold: true },
        "markup.heading.4":     { fg: HEADING, italic: true, bold: true },
        "markup.heading.5":     { fg: HEADING, italic: true },
        "markup.heading.6":     { fg: HEADING, italic: true, dim: true },
        "markup.strong":        { fg: SOFT_WHITE, bold: true },
        "markup.italic":        { fg: SOFT_WHITE, italic: true },
        "markup.strikethrough": { fg: SOFT_WHITE, dim: true },
        "markup.raw":           { fg: CODE_FG, bg: CODE_BG },
        "markup.raw.block":     { fg: CODE_FG, bg: CODE_BLOCK_BG },
        "markup.link":          { fg: LINK, underline: true },
        "markup.link.label":    { fg: LINK, underline: true },
        "markup.link.url":      { fg: LINK_DIM, italic: true },
        "string.special.url":   { fg: LINK_DIM, italic: true },
    });
    return cached;
};
