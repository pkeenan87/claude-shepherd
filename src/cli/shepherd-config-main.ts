/** Entry of the bundled panel CLI (dist/shepherd-config.mjs): runs `main` and exits with its code. */
import { main } from "./shepherd-config.js";

// A closed pipe (| head) is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => process.exit(error.code === "EPIPE" ? 0 : 1));

process.exitCode = await main(process.argv.slice(2));
