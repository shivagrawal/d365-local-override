# PCF Local Override v1.2.8

Local Dynamics development tool for PCF bundles and Model-Driven App JavaScript and HTML web resources. A localhost Node helper owns file watching and Chrome CDP interception; a Manifest V3 extension provides the UI.

## Install helper

Requires Node.js 22 or later.

```bat
install-helper.cmd
```

Manual installation:

```bash
npm install -g .
```

## Load extension

Chrome/Edge Extensions → Developer mode → Load unpacked, then select only:

```text
C:\path\to\pcf-local-override\extension
```

## Daily workflow

```bash
npm run start:watch
pcf-local-override launch --bundle "C:\path\to\out\controls\MyControl"
```

For Model-Driven JavaScript:

```bash
pcf-local-override launch --script "C:\path\to\account-form.js"
```

For Model-Driven HTML:

```bash
pcf-local-override launch --html "C:\path\to\web-resource.html"
```

The extension never reads local files and never owns CDP. The helper binds only to `127.0.0.1:32145`.

## Tests

```bash
npm test
```
