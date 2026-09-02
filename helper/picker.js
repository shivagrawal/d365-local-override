import { execFile } from 'node:child_process';
import path from 'node:path';

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}

export async function pickFolder({ platform = process.platform, title = 'Select folder' } = {}) {
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      `\$dialog.Description = '${String(title).replace(/'/g, "''")}'`,
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }'
    ].join('; ');
    return run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  }

  if (platform === 'darwin') {
    return run('osascript', ['-e', `POSIX path of (choose folder with prompt "${String(title).replace(/"/g, '\\"')}")`]);
  }

  if (platform === 'linux') {
    return run('zenity', ['--file-selection', '--directory', `--title=${title}`]);
  }

  throw new Error(`Folder picker is not supported on ${platform}.`);
}

export async function pickFile({ platform = process.platform, title = 'Select file' } = {}) {
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      `$dialog.Title = '${String(title).replace(/'/g, "''")}'`,
      `$dialog.Filter = 'JavaScript or HTML (*.js;*.html;*.htm)|*.js;*.html;*.htm|All files (*.*)|*.*'`,
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }'
    ].join('; ');
    return run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  }

  if (platform === 'darwin') {
    return run('osascript', ['-e', `POSIX path of (choose file with prompt "${String(title).replace(/"/g, '\\"')}")`]);
  }

  if (platform === 'linux') {
    return run('zenity', ['--file-selection', `--title=${title}`]);
  }

  throw new Error(`File picker is not supported on ${platform}.`);
}

export async function pick({ mode = 'folder', title } = {}) {
  const value = mode === 'file'
    ? await pickFile({ title: title || 'Select local JavaScript or HTML file' })
    : await pickFolder({ title: title || 'Select local PCF project or bundle folder' });

  return value ? path.resolve(value) : null;
}
