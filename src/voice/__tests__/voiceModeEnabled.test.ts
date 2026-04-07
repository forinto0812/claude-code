import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const growthbookState = {
  disabled: false,
};
const providerState = {
  available: false,
};

mock.module("../../services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: boolean) =>
    growthbookState.disabled ?? fallback,
}));

mock.module("../../services/voiceStreamSTT.js", () => ({
  getVoiceModeAvailability: () => ({
    provider: providerState.available ? "openai" : null,
    available: providerState.available,
  }),
}));

const {
  hasAvailableVoiceProvider,
  isVoiceGrowthBookEnabled,
  isVoiceModeEnabled,
} = await import("../voiceModeEnabled.js");

describe("voiceModeEnabled", () => {
  const originalVoiceModeFeature = process.env.FEATURE_VOICE_MODE;

  beforeEach(() => {
    process.env.FEATURE_VOICE_MODE = "1";
    growthbookState.disabled = false;
    providerState.available = false;
  });

  afterEach(() => {
    if (originalVoiceModeFeature === undefined) {
      delete process.env.FEATURE_VOICE_MODE;
    } else {
      process.env.FEATURE_VOICE_MODE = originalVoiceModeFeature;
    }
  });

  test("reports provider availability from voice mode availability", () => {
    providerState.available = true;
    expect(hasAvailableVoiceProvider()).toBe(true);
  });

  test("disables voice mode when no provider is available", () => {
    providerState.available = false;
    expect(isVoiceModeEnabled()).toBe(false);
  });

  test("disables voice mode when growthbook kill switch is on", () => {
    providerState.available = true;
    growthbookState.disabled = true;

    expect(isVoiceGrowthBookEnabled()).toBe(false);
    expect(isVoiceModeEnabled()).toBe(false);
  });
});
