# Development Roadmap

## Stable baseline

**v1.2.8** — known-good Chrome + local helper workflow.

This baseline must remain reproducible and must not be broken by feature work.

## 1. Edge support

Target: run the same local override architecture against Microsoft Edge using its Chromium DevTools Protocol support.

Acceptance criteria:

- Edge can be launched/reused with remote debugging enabled.
- PCF bundle interception works in Edge.
- Model-Driven JavaScript and HTML resource interception remains available.
- Chrome behavior and tests remain green.
- Browser choice can be made explicitly.

## 2. Extension-first workflow

Target developer experience:

`Open extension → choose/paste local file or bundle → discover matching Dynamics resource → enable override`

The developer should not need to manually run `npm install`, `npm start`, `npm watch`, or repeatedly type terminal commands for normal use.

The extension should expose:

- Browser connection status.
- Local path/file selection.
- Automatic resource matching.
- Override enable/disable.
- Current target URL/resource.
- Local file currently being served.
- Reload/reapply controls.
- Useful error diagnostics.

## 3. Plugin debugging

Long-term target: allow a Dynamics 365 developer to work on plugin code locally and debug through Visual Studio without repeatedly deploying/registering the plugin for every iteration.

This phase requires careful architecture because Dataverse server-side plugin execution normally occurs remotely. The design should distinguish between:

- local plugin execution/debugging;
- requests sent to the real Dataverse environment;
- production-safe behavior;
- authentication and service dependencies;
- Visual Studio process/debugger integration.

The first milestone should be a technical spike proving a safe local execution/debug loop before implementing a polished extension UX.

## Branching strategy

Use `main` for stable/integrated work. Create feature branches for major changes, especially Edge and plugin debugging. Tag stable milestones such as `v1.2.8-baseline` before substantial refactoring.
