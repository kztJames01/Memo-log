export enum ExitCode {
  Success = 0,
  ConfigError = 2,
  SecurityError = 3,
  RuntimeError = 4
}

export class CliError extends Error {
  public readonly exitCode: ExitCode;

  public constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
