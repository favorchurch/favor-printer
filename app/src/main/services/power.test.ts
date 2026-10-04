import { describe, expect, it } from "vitest";

import { ACTIVE_WINDOW_MS, createPowerController, powerWarnings, shouldPreventSuspension } from "./power";
import { createFakeTimers } from "./testing/fakes";

const MINUTE = 60_000;
const NOW = new Date("2026-10-04T10:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);

describe("shouldPreventSuspension (D5 boundaries)", () => {
  it("uses a 30 minute window", () => {
    expect(ACTIVE_WINDOW_MS).toBe(30 * MINUTE);
  });

  it("is active 29 minutes after a job", () => {
    expect(shouldPreventSuspension({ printerAttached: true, lastJobAt: minutesAgo(29) }, NOW)).toBe(true);
  });

  it("is inactive 31 minutes after a job", () => {
    expect(shouldPreventSuspension({ printerAttached: true, lastJobAt: minutesAgo(31) }, NOW)).toBe(false);
  });

  it("is inactive at exactly 30 minutes and active one millisecond before", () => {
    expect(shouldPreventSuspension({ printerAttached: true, lastJobAt: minutesAgo(30) }, NOW)).toBe(false);
    const almost = new Date(NOW.getTime() - ACTIVE_WINDOW_MS + 1);
    expect(shouldPreventSuspension({ printerAttached: true, lastJobAt: almost }, NOW)).toBe(true);
  });

  it("is inactive the moment the printer detaches, however fresh the job", () => {
    expect(shouldPreventSuspension({ printerAttached: false, lastJobAt: minutesAgo(0) }, NOW)).toBe(false);
    expect(shouldPreventSuspension({ printerAttached: false, lastJobAt: minutesAgo(1) }, NOW)).toBe(false);
  });

  it("is inactive before any job has arrived", () => {
    expect(shouldPreventSuspension({ printerAttached: true, lastJobAt: null }, NOW)).toBe(false);
  });

  it("reads an ISO string and ignores an unreadable one", () => {
    expect(shouldPreventSuspension({ printerAttached: true, lastJobAt: minutesAgo(5).toISOString() }, NOW)).toBe(true);
    expect(shouldPreventSuspension({ printerAttached: true, lastJobAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("createPowerController", () => {
  function setup() {
    const clock = { now: NOW };
    const fake = createFakeTimers();
    const events: string[] = [];
    let nextId = 100;
    const controller = createPowerController({
      blocker: {
        start: (type) => {
          events.push(`start ${type}`);
          return nextId++;
        },
        stop: (id) => {
          events.push(`stop ${id}`);
        },
      },
      now: () => clock.now,
      timers: fake.timers,
    });
    return { clock, fake, events, controller };
  }

  it("starts once while a printer is attached and a job is recent", () => {
    const { controller, events } = setup();
    expect(controller.update({ printerAttached: true, lastJobAt: minutesAgo(1) })).toBe(true);
    expect(controller.update({ printerAttached: true, lastJobAt: minutesAgo(1) })).toBe(true);
    expect(events).toEqual(["start prevent-app-suspension"]);
  });

  it("does not start before a job, or without a printer", () => {
    const { controller, events } = setup();
    expect(controller.update({ printerAttached: true, lastJobAt: null })).toBe(false);
    expect(controller.update({ printerAttached: false, lastJobAt: minutesAgo(1) })).toBe(false);
    expect(events).toEqual([]);
  });

  it("stops at once when the printer detaches, and cancels the lapse timer", () => {
    const { controller, events, fake } = setup();
    controller.update({ printerAttached: true, lastJobAt: minutesAgo(1) });
    expect(fake.pending.size).toBe(1);

    expect(controller.update({ printerAttached: false, lastJobAt: minutesAgo(1) })).toBe(false);
    expect(events).toEqual(["start prevent-app-suspension", "stop 100"]);
    expect(fake.pending.size).toBe(0);
  });

  it("schedules the lapse for the end of the 30 minute window", () => {
    const { controller, fake } = setup();
    controller.update({ printerAttached: true, lastJobAt: minutesAgo(29) });
    const [timer] = [...fake.pending.values()];
    expect(timer.ms).toBe(MINUTE);
  });

  it("lets go when the window closes, with nothing else prompting it", () => {
    const { controller, events, clock, fake } = setup();
    const lastJobAt = minutesAgo(29);
    controller.update({ printerAttached: true, lastJobAt });

    clock.now = new Date(NOW.getTime() + 2 * MINUTE); // 31 minutes after the job
    fake.fire("timeout");

    expect(events).toEqual(["start prevent-app-suspension", "stop 100"]);
    expect(fake.pending.size).toBe(0);
  });

  it("keeps holding when the timer fires early", () => {
    const { controller, events, clock, fake } = setup();
    controller.update({ printerAttached: true, lastJobAt: minutesAgo(29) });

    clock.now = new Date(NOW.getTime() + 30_000);
    fake.fire("timeout");

    expect(events).toEqual(["start prevent-app-suspension"]);
    expect(fake.pending.size).toBe(1);
  });

  it("holds again when a new job arrives after the window closed", () => {
    const { controller, events, clock } = setup();
    controller.update({ printerAttached: true, lastJobAt: minutesAgo(31) });
    expect(events).toEqual([]);

    clock.now = new Date(NOW.getTime() + 5 * MINUTE);
    expect(controller.update({ printerAttached: true, lastJobAt: clock.now })).toBe(true);
    expect(events).toEqual(["start prevent-app-suspension"]);
  });

  it("releases on dispose", () => {
    const { controller, events, fake } = setup();
    controller.update({ printerAttached: true, lastJobAt: minutesAgo(1) });
    controller.dispose();
    controller.dispose();
    expect(events).toEqual(["start prevent-app-suspension", "stop 100"]);
    expect(fake.pending.size).toBe(0);
  });
});

describe("powerWarnings", () => {
  it("always asks for the lid to stay open and never says closed-lid printing works", () => {
    for (const onBattery of [false, true]) {
      const text = powerWarnings({ onBattery }).join(" ");
      expect(text).toMatch(/keep the lid open/i);
      expect(text).not.toMatch(/lid (is |stays )?closed[^.]*(works|is fine|still prints|will print)/i);
      expect(text).not.toMatch(/(works|is fine|still prints|will print)[^.]*(with|when) the lid closed/i);
    }
  });

  it("warns about battery only on battery", () => {
    expect(powerWarnings({ onBattery: false })).toHaveLength(1);
    const onBattery = powerWarnings({ onBattery: true });
    expect(onBattery).toHaveLength(2);
    expect(onBattery.join(" ")).toMatch(/battery/i);
  });
});
