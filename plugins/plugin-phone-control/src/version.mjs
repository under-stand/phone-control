// Keep release-facing versions in one place. Package and plugin manifests remain
// declarative metadata, while runtime probes and the static PWA cache use these
// values so a release cannot accidentally report or serve an older build.
export const PHONE_CONTROL_VERSION = "0.10.0";
export const PHONE_CONTROL_ASSET_VERSION = 71;
