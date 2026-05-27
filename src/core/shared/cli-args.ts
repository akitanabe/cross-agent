export type OptionDefinition = {
  field: string;
  multiple?: boolean;
  parse?: (value: string, optionName: string) => unknown;
};

export type OptionDefinitions = Record<string, OptionDefinition>;

export function parseIntegerOption(value: string, optionName: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${optionName} must be an integer.`);
  return number;
}

export function parseBooleanOption(value: string, optionName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${optionName} must be true or false.`);
}

export function requireOption<TArgs extends Record<string, unknown>>(
  args: TArgs,
  field: string,
  optionName: string,
): NonNullable<TArgs[string]> {
  if (args[field] == null || args[field] === "") throw new Error(`${optionName} is required.`);
  return args[field] as NonNullable<TArgs[string]>;
}

function parseOptionValue(option: OptionDefinition, value: string, optionName: string): unknown {
  return option.parse ? option.parse(value, optionName) : value;
}

export function parseOptionArgs<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  argv: string[],
  optionDefinitions: OptionDefinitions,
  { startIndex = 0, initialArgs = {} as Partial<TArgs> } = {},
): TArgs {
  const args: Record<string, unknown> = { ...initialArgs };
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
      const values: string[] = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        values.push(argv[++index]);
      }
      if (!values.length) throw new Error(`${arg} requires at least one value.`);
      args[option.field] ??= [];
      (args[option.field] as unknown[]).push(...values.map((value) => parseOptionValue(option, value, arg)));
      continue;
    }

    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    args[option.field] = parseOptionValue(option, value, arg);
  }
  return args as TArgs;
}

export type CommandDefinitions = Record<string, { options?: OptionDefinitions }>;

export function parseCommandArgs<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  argv: string[],
  {
    commands,
    commonOptions = {},
  }: {
    commands: CommandDefinitions;
    commonOptions?: OptionDefinitions;
  },
): TArgs & { command: string | null; help?: boolean } {
  const command = argv[0];
  if (command === "--help" || command === "-h") {
    return { command: null, help: true } as TArgs & { command: string | null; help?: boolean };
  }
  if (command && !commands[command]) throw new Error(`Unknown command: ${command}`);

  return parseOptionArgs(
    argv,
    { ...commonOptions, ...(commands[command]?.options ?? {}) },
    {
      startIndex: 1,
      initialArgs: { command } as unknown as Partial<TArgs>,
    },
  ) as TArgs & { command: string | null; help?: boolean };
}
