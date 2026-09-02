export function parseLaunchArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!['--root', '--bundle', '--script', '--html'].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a folder or file path.`);
    }
    options[argument.slice(2)] = value;
  }
  const fileModes = ['bundle', 'script', 'html'].filter(mode => options[mode]);
  if (fileModes.length > 1) throw new Error('Use only one of --bundle, --script, or --html.');
  return options;
}
