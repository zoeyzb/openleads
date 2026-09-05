import { spawn } from "node:child_process";

let stopping = false;

function start(name, file, restart = false) {
  const child = spawn(process.execPath, [file], {
    stdio: "inherit",
    env: process.env
  });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${name} exited code=${code} signal=${signal}`);
    if (restart) {
      setTimeout(() => start(name, file, true), 3000);
    } else {
      process.exit(code || 1);
    }
  });

  return child;
}

const server = start("mcp-server", "recover-mcp/server.mjs", false);
let worker = start("acquisition-worker", "recover-mcp/acquisition-worker.mjs", true);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`launcher received ${signal}, shutting down`);
  try { server.kill(signal); } catch {}
  try { worker.kill(signal); } catch {}
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
