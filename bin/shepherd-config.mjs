#!/usr/bin/env node
// Thin shim: runs the bundled panel CLI (npm run bundle writes dist/shepherd-config.mjs, which is tracked in git).
import "../dist/shepherd-config.mjs";
