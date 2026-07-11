/**
 * Decide what "Make full-featured" should do for a given dry-run report, WITHOUT
 * touching the DOM or IPC (pure → unit-tested). The overlay swaps a board's
 * firmware for Studio's bundled full-launcher build; a board is reported in
 * `skippedNewer` when Studio's bundled launcher firmware is too old to accept the
 * apps this SDK builds (app SDK-minor > firmware's), because overlaying it would
 * DOWNGRADE the firmware and make those apps be rejected on-watch ("requires a
 * newer version of the Pebble firmware").
 *
 * The old flow offered a bare "Apply anyway" that silently downgraded every board
 * — the trap this planner removes: the SAFE outcome is always the default, and a
 * downgrade is only ever an explicitly-labelled opt-in.
 */
export interface FullLauncherReportLike {
  applied: string[];
  skippedNewer: string[];
  skippedMissing: string[];
}

export interface FullLauncherDialog {
  title: string;
  /** Body paragraphs (plain text; the renderer escapes + wraps them). */
  lines: string[];
  /** Primary, reassuring button — never downgrades. */
  safeLabel: string;
  /** `force` value the primary button applies (false = never downgrades). */
  safeForce: boolean;
  /** Optional destructive opt-in (force = true). Omitted when a downgrade makes
   * no sense. */
  downgradeLabel?: string;
}

export interface FullLauncherPlan {
  /** When set, show this dialog and act on the choice; when null, apply directly
   * (no downgrade risk) with `autoForce`. */
  dialog: FullLauncherDialog | null;
  autoForce: boolean;
}

const list = (xs: string[]): string => xs.join(", ");

/**
 * Turn a dry-run report + the SDK version into a plan. No `skippedNewer` → no
 * downgrade risk, apply straight away. Otherwise surface the risk and default to
 * the non-destructive choice.
 */
export function planFullLauncherApply(
  report: FullLauncherReportLike,
  version: string,
): FullLauncherPlan {
  const newer = report.skippedNewer;
  if (newer.length === 0) {
    // Bundled launcher is same-or-newer everywhere it applies — safe to apply.
    return { dialog: null, autoForce: false };
  }

  const rejectNote =
    'apps built with this SDK would then be rejected ("requires a newer version ' +
    'of the Pebble firmware"). You can Revert to stock firmware at any time.';

  if (report.applied.length > 0) {
    // Mixed: some boards can take the launcher safely; on the others the bundled
    // launcher firmware is too old to accept this SDK's apps. Default = add only
    // where it's safe.
    return {
      autoForce: false,
      dialog: {
        title: "Studio's launcher can't run this SDK's apps everywhere",
        lines: [
          `Apps built with SDK ${version} need a firmware newer than Studio's bundled launcher on ${list(newer)}.`,
          `Studio can add the full launcher to ${list(report.applied)} without touching ${list(newer)}.`,
          `Overlaying Studio's launcher on ${list(newer)} would downgrade the firmware, so ${rejectNote}`,
        ],
        safeLabel: `Add to ${list(report.applied)} only`,
        safeForce: false,
        downgradeLabel: "Downgrade all anyway",
      },
    };
  }

  // Every eligible board's apps need a firmware newer than Studio's bundled
  // launcher, so overlaying it would make those apps be rejected. Default = leave
  // the firmware alone; downgrading is a clearly-marked escape hatch.
  return {
    autoForce: false,
    dialog: {
      title: "Studio's launcher can't run this SDK's apps",
      lines: [
        `Apps built with SDK ${version} need a firmware newer than Studio's bundled launcher (${list(newer)}).`,
        `Overlaying Studio's launcher there would downgrade the firmware, so ${rejectNote} ` +
          `Studio's launcher is applied everywhere it's compatible.`,
      ],
      safeLabel: "Keep current firmware",
      safeForce: false,
      downgradeLabel: "Downgrade anyway",
    },
  };
}
