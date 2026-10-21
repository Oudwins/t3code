import { describe, expect, test } from "vite-plus/test";

import { createPageScrollController, getTimelinePageScrollKey } from "./pageScrollController";

// Matches the controller's page scroll animation length.
const PAGE_SCROLL_ANIMATION_MS = 150;

class TestClock {
  private currentTime = 0;
  private nextHandle = 1;
  private animationFrames = new Map<number, FrameRequestCallback>();
  private timeouts = new Map<number, { at: number; callback: () => void }>();

  reducedMotion = false;

  readonly env = {
    now: () => this.currentTime,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.animationFrames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => {
      this.animationFrames.delete(handle);
    },
    setTimeout: (callback: () => void, delay: number) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.timeouts.set(handle, { at: this.currentTime + delay, callback });
      return handle;
    },
    clearTimeout: (handle: number) => {
      this.timeouts.delete(handle);
    },
    prefersReducedMotion: () => this.reducedMotion,
  };

  advanceBy(ms: number, frameMs = 16) {
    const target = this.currentTime + ms;

    while (this.currentTime < target) {
      this.currentTime = Math.min(target, this.currentTime + frameMs);
      this.flushTimeouts();
      this.flushAnimationFrames();
    }
  }

  private flushTimeouts() {
    let hasDueTimeouts = true;
    while (hasDueTimeouts) {
      hasDueTimeouts = false;

      for (const [handle, timeout] of this.timeouts) {
        if (timeout.at > this.currentTime) {
          continue;
        }

        this.timeouts.delete(handle);
        timeout.callback();
        hasDueTimeouts = true;
      }
    }
  }

  private flushAnimationFrames() {
    if (this.animationFrames.size === 0) {
      return;
    }

    const frames = [...this.animationFrames.values()];
    this.animationFrames.clear();

    for (const callback of frames) {
      callback(this.currentTime);
    }
  }
}

describe("page scroll helpers", () => {
  const composerPageScrollEvent = (
    overrides: Partial<Parameters<typeof getTimelinePageScrollKey>[0]> = {},
  ) => ({
    altKey: false,
    clientHeight: 200,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key: "PageDown",
    keyCode: 34,
    metaKey: false,
    scrollHeight: 200,
    scrollTop: 0,
    shiftKey: false,
    ...overrides,
  });

  test("leaves page keys to IME composition", () => {
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ isComposing: true }))).toBeNull();
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ keyCode: 229 }))).toBeNull();
  });

  test("leaves page keys to an overflowing composer until it reaches the boundary", () => {
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 0 })),
    ).toBeNull();
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 400,
        }),
      ),
    ).toBeNull();

    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 400 })),
    ).toBe("PageDown");
  });

  test("hands off page keys within a fractional pixel of the composer boundary", () => {
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0.5,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 399.5 })),
    ).toBe("PageDown");
  });

  test("steps half a page per press and continues from the pending target on repeat", () => {
    const clock = new TestClock();
    const container = {
      clientHeight: 600,
      scrollHeight: 4_000,
      scrollTop: 0,
      getBoundingClientRect: () => ({ height: 600 }),
    };
    const controller = createPageScrollController({
      getContainer: () => container,
      getScrollPaddingBottomPx: () => 24,
      env: clock.env,
    });
    // A page is the container minus the 36px alignment offset and the bottom padding.
    const halfPage = (600 - 36 - 24) / 2;

    controller.stepHalfPage("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);
    expect(container.scrollTop).toBeCloseTo(halfPage, 5);

    controller.stepHalfPage("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS / 3);
    controller.stepHalfPage("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);
    expect(container.scrollTop).toBeCloseTo(halfPage * 3, 5);

    controller.stepHalfPage("PageUp");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);
    expect(container.scrollTop).toBeCloseTo(halfPage * 2, 5);
  });

  test("clamps repeated half page steps to the end of the timeline", () => {
    const clock = new TestClock();
    const container = {
      clientHeight: 600,
      scrollHeight: 1_000,
      scrollTop: 0,
      getBoundingClientRect: () => ({ height: 600 }),
    };
    const controller = createPageScrollController({
      getContainer: () => container,
      getScrollPaddingBottomPx: () => 24,
      env: clock.env,
    });

    for (let press = 0; press < 5; press += 1) {
      controller.stepHalfPage("PageDown");
      clock.advanceBy(16);
    }
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);
    expect(container.scrollTop).toBeCloseTo(400, 5);

    controller.stepHalfPage("PageUp");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);
    expect(container.scrollTop).toBeLessThan(400);
  });
});
