import { SyntaxStyle } from "@opentui/core";

let cached: SyntaxStyle | null = null;

/**
 * Lazily build a single SyntaxStyle instance reused by every <markdown> in
 * the app. Creating the style allocates native resources, so we share one.
 */
export const getMarkdownStyle = (): SyntaxStyle => {
    if (cached) return cached;
    cached = SyntaxStyle.create();
    return cached;
};
