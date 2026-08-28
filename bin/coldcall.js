#!/usr/bin/env node
// Thin launcher so the shim never needs to know the internal layout.
import { main } from "../src/server/main.ts";
main(process.argv.slice(2)).catch((e) => { console.error("[coldcall] fatal:", e); process.exit(1); });
