#!/usr/bin/env node
import { fail, runBuild } from "../cli.js";

try {
  process.exit(runBuild(process.argv.slice(2), process.env));
} catch (e) {
  fail(e);
}
