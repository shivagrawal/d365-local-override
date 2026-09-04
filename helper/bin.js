#!/usr/bin/env node
import { parseLaunchArgs } from './cli.js';
import { launch } from './main.js';

const [command, ...args] = process.argv.slice(2);
const help = `d365-local-override launch [--root <project-folder>] [--bundle <bundle-file-or-folder>] [--script <javascript-file>] [--html <html-file>]

Examples:
  d365-local-override launch --bundle "C:\\path\\to\\out\\controls\\MyControl"
  d365-local-override launch --script "C:\\path\\to\\account-form.js"
  d365-local-override launch --html "C:\\path\\to\\custom-page.html"
  d365-local-override launch --root "C:\\path\\to\\pcf-project"

Use --script or --html for an existing Model-Driven App web resource. Without options, the current folder is used as a PCF project root.`;

if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log(help);
  process.exit(0);
}
if (command !== 'launch') {
  console.error(`Unknown command: ${command}\n\n${help}`);
  process.exit(1);
}

try {
  await launch(parseLaunchArgs(args));
} catch (error) {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
}
