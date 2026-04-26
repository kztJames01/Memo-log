import { runCli } from "./cli/runCli.js";

const main = async (): Promise<void> => {
  process.exitCode = await runCli();
};

void main();
