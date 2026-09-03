import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Build the OS-native picker invocation. Kept pure and separate from spawning so
 * the per-platform command shapes can be unit tested without opening a dialog.
 *
 * mode: 'folder' (PCF bundle output folder) | 'file' (bundle.js / form script / HTML)
 * Returns { command, args } or throws for unsupported platforms.
 */
export function buildPickerCommand(platform, mode = 'folder', { title = 'Select local resource' } = {}) {
  if (!['folder', 'file'].includes(mode)) {
    throw new Error(`Unsupported picker mode: ${mode}`);
  }

  if (platform === 'win32') {
    // -STA is required: the WinForms dialogs need a single-threaded apartment.
    const script = mode === 'folder'
      ? `Add-Type -AssemblyName System.Windows.Forms;` +
        `$d = New-Object System.Windows.Forms.FolderBrowserDialog;` +
        `$d.Description = '${title.replace(/'/g, "''")}';` +
        `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`
      : `Add-Type -AssemblyName System.Windows.Forms;` +
        `$d = New-Object System.Windows.Forms.OpenFileDialog;` +
        `$d.Title = '${title.replace(/'/g, "''")}';` +
        `$d.Filter = 'Web resources (*.js;*.html;*.htm)|*.js;*.html;*.htm|All files (*.*)|*.*';` +
        `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }`;

    return { command: 'powershell', args: ['-NoProfile', '-STA', '-Command', script] };
  }

  if (platform === 'darwin') {
    const chooser = mode === 'folder' ? 'choose folder' : 'choose file';
    return {
      command: 'osascript',
      args: ['-e', `POSIX path of (${chooser} with prompt "${title.replace(/"/g, '\\"')}")`]
    };
  }

  if (platform === 'linux') {
    const args = ['--file-selection', `--title=${title}`];
    if (mode === 'folder') args.push('--directory');
    return { command: 'zenity', args };
  }

  throw new Error(`Native file picker is not supported on platform "${platform}".`);
}

/**
 * Normalize picker stdout. Returns an absolute path, or null when the user
 * cancelled (dialogs exit with empty output on cancel).
 */
export function parsePickerOutput(stdout) {
  const value = String(stdout ?? '').replace(/\r/g, '').trim();
  if (!value) return null;

  // macOS `POSIX path of` appends a trailing separator to folders.
  const trimmed = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  return path.normalize(trimmed);
}

/**
 * Open the OS picker and resolve to the chosen absolute path, or null if cancelled.
 */
export function pickPath(mode = 'folder', options = {}) {
  const { command, args } = buildPickerCommand(process.platform, mode, options);

  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: false, timeout: 300000 }, (error, stdout) => {
      const chosen = parsePickerOutput(stdout);

      // Cancel is reported as a non-zero exit by osascript/zenity; treat an
      // empty selection as a cancellation rather than a failure.
      if (error && !chosen) {
        if (error.code === 'ENOENT') {
          return reject(new Error(
            command === 'zenity'
              ? 'zenity is required for the file picker on Linux.'
              : `Picker command "${command}" was not found.`
          ));
        }
        return resolve(null);
      }

      resolve(chosen);
    });
  });
}
