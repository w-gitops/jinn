import { describe, it, expect } from "vitest";
import { rateLimitFromStopFailure } from "../interactive-ratelimit.js";

describe("rateLimitFromStopFailure", () => {
  it("maps a rate_limit error to a rejected EngineRateLimitInfo", () => {
    const info = rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
    expect(info?.status).toBe("rejected");
    expect(info?.rateLimitType).toBe("interactive_detected");
  });

  it("returns null for a non-rate-limit StopFailure error", () => {
    expect(rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "server_error" })).toBe(null);
    expect(rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "billing_error" })).toBe(null);
  });

  it("returns null for non-StopFailure / missing error / undefined", () => {
    expect(rateLimitFromStopFailure({ hook_event_name: "Stop" })).toBe(null);
    expect(rateLimitFromStopFailure({ hook_event_name: "StopFailure" })).toBe(null);
    expect(rateLimitFromStopFailure(undefined)).toBe(null);
  });
});
