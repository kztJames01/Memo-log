import { runCli } from "./cli/runCli.js";
import { validateParsedFile } from "./parsers/index.js";

const main = async (): Promise<void> => {
  process.exitCode = await runCli();
};

void main();

export { validateParsedFile };
