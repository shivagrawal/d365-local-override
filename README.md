# D365 Local Override (PatchPilot) v2.0.0

Local Dynamics development tool for PCF bundles and Model-Driven App JavaScript and HTML web resources. A localhost Node helper owns file watching and Chrome CDP interception; a Manifest V3 extension provides the UI.

## Install helper

Requires Node.js 22 or later.

```bat
install-native-host.cmd <extension-id>
```

Manual installation:

```bash
npm install -g .
```

## Load extension

Chrome/Edge Extensions → Developer mode → Load unpacked, then select only:

```text
C:\path\to\d365-local-override\extension
```

## Daily workflow

```bash
npm run start:watch
d365-local-override launch --bundle "C:\path\to\out\controls\MyControl"
```

For Model-Driven JavaScript:

```bash
d365-local-override launch --script "C:\path\to\account-form.js"
```

For Model-Driven HTML:

```bash
d365-local-override launch --html "C:\path\to\web-resource.html"
```

The extension never reads local files and never owns CDP. The helper binds only to `127.0.0.1:32145`.

## Tests

```bash
npm test
```
