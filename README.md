# D365 Local Override

Local development helper for Dynamics 365 / Power Platform web resources and PCF bundles.

## Baseline

This repository starts from the stable `pcf-local-override` v1.2.8 baseline.

The stable package is preserved as the reference point while development proceeds toward:

1. Microsoft Edge support.
2. A zero-terminal developer workflow through the browser extension: select/paste a local JS/HTML/PCF bundle path, discover the matching Dynamics resource, and enable the override.
3. Local Dynamics 365 plugin debugging by attaching Visual Studio to the appropriate process, with the goal of testing plugin code locally without repeated server deployment/registration.

## Current stable workflow

The v1.2.8 helper launches a local override helper and connects to a development Chrome instance. It supports PCF bundles and existing Model-Driven App JavaScript/HTML resources.

## Development principles

- Do not destabilize the known-good v1.2.8 behavior.
- Build new browser support and UX incrementally behind the stable baseline.
- Keep Chrome behavior working while Edge support is added.
- Prefer a single-click developer workflow over terminal commands.
- Keep local override, browser integration, and future plugin-debugging capabilities modular.

## Roadmap

### Phase 1 — Edge
- Detect/use Microsoft Edge with remote debugging.
- Reuse the existing CDP interception architecture where compatible.
- Keep Chrome as a supported option.
- Add automated tests for browser selection and launch configuration.

### Phase 2 — Extension-first UX
- Browser extension popup/dashboard.
- Local file/folder selection or path entry.
- Automatic Dynamics resource discovery/matching.
- One-click enable/disable override.
- Clear connection and override status.
- Preserve the existing helper as the compatibility backend during migration.

### Phase 3 — Plugin local debugging
- Define the local plugin execution/debug architecture.
- Integrate Visual Studio attach/debug workflow.
- Intercept or redirect eligible plugin execution where technically possible.
- Avoid requiring plugin registration/deployment for every development iteration.
- Add explicit safeguards so production/real tenant execution cannot be unintentionally redirected.

## Versioning

The v1.2.8 baseline is considered stable. Future work should use feature branches/tags and should not silently replace the stable behavior.
