#!/usr/bin/env node
/**
 * Development mode: backend with tsx watch (:8787) + Vite dev server (:5173,
 * proxies /api to the backend). Ctrl-C stops both.
 */
import { spawn } from 'node:child_process';

const children = [];

function run(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false });
  children.push(child);
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
  });
  return child;
}

run('server', 'npx', ['tsx', 'watch', 'src/server/main.ts']);
run('web', 'npx', ['vite', '--host']);

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
