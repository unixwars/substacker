#!/usr/bin/env node
import { fail, runScrape } from "../cli.js";

runScrape(process.argv.slice(2), process.env).then((code) => process.exit(code), fail);
