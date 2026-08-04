#!/usr/bin/env node
import { runCli } from './index.js';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Launchpad CLI failed.'}\n`);
  process.exitCode = 1;
}
