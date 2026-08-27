import test from "node:test";
import assert from "node:assert/strict";
import { geometryFromReading, probeDisplayGeometry } from "../dist/display-probe.js";

const AT = new Date("2026-05-08T00:00:00.000Z");

test("geometryFromReading reads a notched display's right-hand bar as the budget", () => {
  // Reference machine: 13" 2560x1664, 1470pt logical, 179pt notch, 645pt to
  // the right of it. Everything left of the notch belongs to the app menus.
  const geometry = geometryFromReading(
    { screenWidthPt: 1470, auxiliaryTopRightPt: 645 },
    AT,
  );
  assert.deepEqual(geometry, {
    screenWidthPt: 1470,
    hasNotch: true,
    extrasBudgetPt: 645,
    measuredAt: "2026-05-08T00:00:00.000Z",
  });
});

test("geometryFromReading reserves app menu space on a full-width menu bar", () => {
  const geometry = geometryFromReading(
    { screenWidthPt: 2560, auxiliaryTopRightPt: 0 },
    AT,
  );
  assert.equal(geometry.hasNotch, false);
  assert.equal(geometry.extrasBudgetPt, 1960);
});

test("geometryFromReading treats a full-frame auxiliary area as no notch", () => {
  // macOS reports either a zero rect or the whole frame when there is no
  // notch; both mean the entire bar is available, minus the app menus.
  const geometry = geometryFromReading(
    { screenWidthPt: 1920, auxiliaryTopRightPt: 1920 },
    AT,
  );
  assert.equal(geometry.hasNotch, false);
  assert.equal(geometry.extrasBudgetPt, 1320);
});

test("geometryFromReading never reports a negative budget", () => {
  const geometry = geometryFromReading(
    { screenWidthPt: 480, auxiliaryTopRightPt: 0 },
    AT,
  );
  assert.equal(geometry.extrasBudgetPt, 0);
});

test("geometryFromReading rejects an unusable screen width", () => {
  assert.equal(geometryFromReading({ screenWidthPt: 0, auxiliaryTopRightPt: 0 }, AT), null);
  assert.equal(geometryFromReading({ screenWidthPt: Number.NaN, auxiliaryTopRightPt: 0 }, AT), null);
  assert.equal(geometryFromReading({}, AT), null);
});

test("probeDisplayGeometry returns a usable reading or null, never throws", () => {
  // Runs headless in CI and on locked screens; a failed measurement must
  // degrade the title tier, never take the usage collection down with it.
  const geometry = probeDisplayGeometry(AT);
  if (geometry === null) {
    return;
  }
  assert.equal(typeof geometry.screenWidthPt, "number");
  assert.equal(typeof geometry.hasNotch, "boolean");
  assert.ok(geometry.extrasBudgetPt >= 0);
  assert.equal(geometry.measuredAt, "2026-05-08T00:00:00.000Z");
});
