#!/usr/bin/env bun
import { runCli } from "@lilos/surfaces";

process.exitCode = await runCli(process.argv.slice(2), process.env);
