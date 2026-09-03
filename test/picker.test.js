import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPickerCommand, parsePickerOutput } from '../helper/picker.js';

test('builds a Windows folder picker in a single-threaded apartment', () => {
  const { command, args } = buildPickerCommand('win32', 'folder');
  assert.equal(command, 'powershell');
  assert.ok(args.includes('-STA'), 'WinForms dialogs require -STA or they never appear');
  assert.ok(args.includes('-NoProfile'));
  assert.match(args.at(-1), /FolderBrowserDialog/);
  assert.match(args.at(-1), /SelectedPath/);
});

test('builds a Windows file picker filtered to web resource types', () => {
  const { args } = buildPickerCommand('win32', 'file');
  const script = args.at(-1);
  assert.match(script, /OpenFileDialog/);
  assert.match(script, /\*\.js;\*\.html;\*\.htm/);
  assert.match(script, /FileName/);
});

test('escapes single quotes in the Windows dialog title', () => {
  const { args } = buildPickerCommand('win32', 'folder', { title: "Shiv's bundle" });
  assert.match(args.at(-1), /Shiv''s bundle/, "an unescaped quote would break the PowerShell string");
});

test('builds macOS and Linux pickers for both modes', () => {
  const macFolder = buildPickerCommand('darwin', 'folder');
  assert.equal(macFolder.command, 'osascript');
  assert.match(macFolder.args.at(-1), /choose folder/);

  const macFile = buildPickerCommand('darwin', 'file');
  assert.match(macFile.args.at(-1), /choose file/);

  const linuxFolder = buildPickerCommand('linux', 'folder');
  assert.equal(linuxFolder.command, 'zenity');
  assert.ok(linuxFolder.args.includes('--directory'));

  const linuxFile = buildPickerCommand('linux', 'file');
  assert.ok(!linuxFile.args.includes('--directory'));
});

test('rejects unsupported platforms and modes', () => {
  assert.throws(() => buildPickerCommand('aix', 'folder'), /not supported on platform/);
  assert.throws(() => buildPickerCommand('win32', 'network-share'), /Unsupported picker mode/);
});

test('parsePickerOutput normalizes real selections', () => {
  assert.equal(parsePickerOutput('C:\\proj\\out\\MyControl\r\n'), 'C:\\proj\\out\\MyControl');
  assert.equal(parsePickerOutput('  /home/shiv/proj/out  '), '/home/shiv/proj/out');
});

test('parsePickerOutput strips the trailing separator macOS adds to folders', () => {
  assert.equal(parsePickerOutput('/Users/shiv/proj/out/'), '/Users/shiv/proj/out');
});

test('parsePickerOutput treats empty output as a cancelled dialog', () => {
  assert.equal(parsePickerOutput(''), null);
  assert.equal(parsePickerOutput('   \r\n  '), null);
  assert.equal(parsePickerOutput(undefined), null);
  assert.equal(parsePickerOutput(null), null);
});
