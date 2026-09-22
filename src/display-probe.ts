import { execFileSync } from "node:child_process";
import { DisplayGeometry } from "./types.js";

// The frontmost app's menus own the left half of the menu bar and their width
// swings with whatever is focused (Chrome ~580pt, Finder ~200pt). Measuring it
// for real means an Accessibility-permission AX sweep that costs 4.8s, so we
// reserve a conservative constant instead. Erring high only demotes the title
// one tier; erring low overflows the bar and macOS hides the item outright.
const APP_MENU_RESERVE_PT = 600;

const PROBE_TIMEOUT_MS = 5_000;

// AppKit lives in the producer, never in the render path: spawning an
// AppKit-linked process talks to the WindowServer and stalls the display.
// The daemon runs this once every 300s, so the ~200ms is free there.
const PROBE_SCRIPT = `ObjC.import('AppKit');
// screens[0] is the menu bar display. NSScreen.mainScreen follows the key
// window instead and would report the wrong screen in a multi-display setup.
var screen = $.NSScreen.screens.objectAtIndex(0);
var frame = screen.frame;
var width = frame.size.width;
var right = 0;
try {
  var area = screen.auxiliaryTopRightArea;
  if (area && area.size) {
    right = area.size.width;
  }
} catch (error) {
  right = 0;
}
JSON.stringify({ screenWidthPt: width, auxiliaryTopRightPt: right });`;

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export interface DisplayProbeReading {
  screenWidthPt: number;
  auxiliaryTopRightPt: number;
}

// Split out from the spawn so the budget policy is testable without a screen.
export function geometryFromReading(
  reading: DisplayProbeReading,
  measuredAt: Date,
): DisplayGeometry | null {
  if (!isPositiveFinite(reading.screenWidthPt)) {
    return null;
  }
  const screenWidthPt = Math.round(reading.screenWidthPt);
  const auxiliary = reading.auxiliaryTopRightPt;
  // A notch splits the bar into two auxiliary areas, so the right-hand one is
  // strictly narrower than the screen. Without a notch macOS may report either
  // a zero rect or the full frame; both mean "no notch, whole bar available".
  const hasNotch = isPositiveFinite(auxiliary) && auxiliary < screenWidthPt - 1;
  const extrasBudgetPt = hasNotch
    ? Math.round(auxiliary)
    : Math.max(0, screenWidthPt - APP_MENU_RESERVE_PT);
  return {
    screenWidthPt,
    hasNotch,
    extrasBudgetPt,
    measuredAt: measuredAt.toISOString(),
  };
}

export function probeDisplayGeometry(measuredAt: Date = new Date()): DisplayGeometry | null {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", PROBE_SCRIPT], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output.trim()) as DisplayProbeReading;
    return geometryFromReading(parsed, measuredAt);
  } catch {
    // Headless launchd contexts, a locked screen, or a future AppKit change
    // all land here. A missing measurement degrades the title tier; it must
    // never take the usage collection down with it.
    return null;
  }
}
