export function parseIntegerOption(value, optionName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${optionName} must be an integer.`);
  return number;
}

export function requireOption(args, field, optionName) {
  if (args[field] == null || args[field] === "") throw new Error(`${optionName} is required.`);
  return args[field];
}

function parseOptionValue(option, value, optionName) {
  return option.parse?.(value, optionName) ?? value;
}

export function parseOptionArgs(argv, optionDefinitions, { startIndex = 0, initialArgs = {} } = {}) {
  const args = { ...initialArgs };
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    const option = optionDefinitions[arg];
    if (!option) {
      if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    if (option.multiple) {
      const values = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        values.push(argv[++index]);
      }
      if (!values.length) throw new Error(`${arg} requires at least one value.`);
      args[option.field] ??= [];
      args[option.field].push(...values.map((value) => parseOptionValue(option, value, arg)));
      continue;
    }

    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    args[option.field] = parseOptionValue(option, value, arg);
  }
  return args;
}

export function parseCommandArgs(argv, { commands, commonOptions = {} }) {
  const command = argv[0];
  if (command === "--help" || command === "-h") {
    return { command: null, help: true };
  }
  if (command && !commands[command]) throw new Error(`Unknown command: ${command}`);

  return parseOptionArgs(argv, { ...commonOptions, ...(commands[command]?.options ?? {}) }, {
    startIndex: 1,
    initialArgs: { command },
  });
}
