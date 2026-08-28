/**
 * The sending window.
 *
 * A run started in the evening will work through the night at one message a minute, and a
 * cold email that lands at 03:14 on a Sunday is read as a machine before it is read at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WINDOW, describeWindow, isOpen, nextOpen, normaliseWindow } from "../../src/server/queue/window.ts";

const at = (iso: string) => new Date(iso);   // local time, which is what the window is in
const OFFICE = normaliseWindow({ enabled: true, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] });

test("an office window is open on a weekday morning and shut at night", () => {
  assert.equal(isOpen(OFFICE, at("2026-08-26T10:00:00")), true, "Wed 10:00");
  assert.equal(isOpen(OFFICE, at("2026-08-26T03:00:00")), false, "Wed 03:00");
});

test("the end hour is exclusive, so nothing starts at closing time", () => {
  assert.equal(isOpen(OFFICE, at("2026-08-26T16:59:00")), true);
  assert.equal(isOpen(OFFICE, at("2026-08-26T17:00:00")), false);
});

test("weekends are shut", () => {
  assert.equal(isOpen(OFFICE, at("2026-08-29T10:00:00")), false, "Saturday");
  assert.equal(isOpen(OFFICE, at("2026-08-30T10:00:00")), false, "Sunday");
});

test("a disabled window never blocks anything", () => {
  const off = normaliseWindow({ enabled: false, startHour: 9, endHour: 17, days: [1] });
  assert.equal(isOpen(off, at("2026-08-30T03:00:00")), true);
  assert.equal(nextOpen(off, at("2026-08-30T03:00:00")), undefined);
});

test("a window that wraps past midnight is honoured, and the day is the day it opened", () => {
  // 22:00 Friday to 06:00 Saturday is one window, not two. Getting this wrong would either
  // shut the window at midnight or leave it open every night of the week.
  const overnight = normaliseWindow({ enabled: true, startHour: 22, endHour: 6, days: [5] });
  assert.equal(isOpen(overnight, at("2026-08-28T23:00:00")), true, "Fri 23:00");
  assert.equal(isOpen(overnight, at("2026-08-29T02:00:00")), true, "Sat 02:00, still Friday's window");
  assert.equal(isOpen(overnight, at("2026-08-29T08:00:00")), false, "Sat 08:00");
  assert.equal(isOpen(overnight, at("2026-08-30T02:00:00")), false, "Sun 02:00 is Saturday's, which is not listed");
});

test("start equal to end is an empty window, not a 24-hour one", () => {
  const empty = normaliseWindow({ enabled: true, startHour: 9, endHour: 9, days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(isOpen(empty, at("2026-08-26T09:00:00")), false);
  assert.equal(isOpen(empty, at("2026-08-26T12:00:00")), false);
});

test("nextOpen finds the next weekday morning across a weekend", () => {
  const d = nextOpen(OFFICE, at("2026-08-29T10:00:00"))!;   // Saturday
  assert.equal(d.getDay(), 1, "Monday");
  assert.equal(d.getHours(), 9);
  assert.equal(d.getDate(), 31);
});

test("nextOpen is later the same day when it is only early", () => {
  const d = nextOpen(OFFICE, at("2026-08-26T03:00:00"))!;
  assert.equal(d.getDate(), 26);
  assert.equal(d.getHours(), 9);
});

test("nextOpen returns nothing when the window is already open", () => {
  assert.equal(nextOpen(OFFICE, at("2026-08-26T10:00:00")), undefined);
});

test("nextOpen terminates rather than looping when no day is selected", () => {
  // normaliseWindow prevents this, but an infinite loop in the send path would hang the
  // whole process, so the bound is asserted rather than trusted.
  const impossible = { enabled: true, startHour: 9, endHour: 17, days: [] as number[] };
  assert.equal(nextOpen(impossible, at("2026-08-26T03:00:00")), undefined);
});

test("bad settings fall back instead of producing a window that blocks everything", () => {
  const w = normaliseWindow({ enabled: true, startHour: 99, endHour: -4, days: [9, 1, 1] as number[] });
  assert.equal(w.startHour, DEFAULT_WINDOW.startHour);
  assert.equal(w.endHour, DEFAULT_WINDOW.endHour);
  assert.deepEqual(w.days, [1], "9 is dropped, the duplicate collapses");
  assert.deepEqual(normaliseWindow(undefined), DEFAULT_WINDOW);
  assert.deepEqual(normaliseWindow({ enabled: true, days: [] }).days, DEFAULT_WINDOW.days, "an empty day list would block forever");
});

test("the description is something a person can read", () => {
  assert.equal(describeWindow(OFFICE), "09:00-17:00, Mon to Fri");
  assert.equal(describeWindow(normaliseWindow({ ...OFFICE, days: [0, 1, 2, 3, 4, 5, 6] })), "09:00-17:00, every day");
  assert.equal(describeWindow(normaliseWindow({ ...OFFICE, days: [2] })), "09:00-17:00, Tuesdays");
  assert.equal(describeWindow(normaliseWindow({ ...OFFICE, days: [1, 3] })), "09:00-17:00, Mon, Wed");
  assert.equal(describeWindow({ ...OFFICE, enabled: false }), "any time");
});
