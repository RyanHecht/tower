import { useEffect, useRef, useState } from "react";
import { shutdown } from "./shutdown.js";

/**
 * Copilot-CLI-style quit semantics: the *second* Ctrl+C within `windowMs`
 * exits the app. The first press shows a hint via the supplied setter and
 * arms the quit. If the user does anything else during the window, the arm
 * silently expires.
 *
 * Returns a `pressedCtrlC()` callback that views can call from their own
 * Ctrl+C handler after they've decided no other action was warranted (e.g.,
 * "no selection to copy", "no turn to abort"). The hook does not register a
 * keybinding itself so each view stays in control of precedence.
 */
export function useDoubleCtrlCQuit(
    setHint: (hint: string | null) => void,
    windowMs = 1500,
): { pressedCtrlC: () => void; armWithMessage: (message: string) => void } {
    const armedRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const disarm = () => {
        armedRef.current = false;
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setHint(null);
    };

    const arm = (message: string) => {
        armedRef.current = true;
        setHint(message);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            armedRef.current = false;
            timerRef.current = null;
            setHint(null);
        }, windowMs);
    };

    const pressedCtrlC = () => {
        if (armedRef.current) {
            disarm();
            shutdown(0);
            return;
        }
        arm("press Ctrl+C again to exit");
    };

    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    return { pressedCtrlC, armWithMessage: arm };
}

/** Sugar for views that just need a string-state hint pinned to the footer. */
export function useQuitHint(): [string | null, (s: string | null) => void] {
    const [hint, setHint] = useState<string | null>(null);
    return [hint, setHint];
}
