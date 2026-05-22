import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  loadInstances,
  saveInstances,
  nextAvailablePort,
  type Instance,
} from "./instances.js";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export async function runCreate(name: string, port?: number): Promise<void> {
  // Validate name
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(`${RED}Error:${RESET} Instance name must be lowercase alphanumeric with hyphens (e.g. "atlas", "my-bot").`);
    process.exit(1);
  }

  if (name === "jinn") {
    console.error(`${RED}Error:${RESET} "jinn" is the default instance. Use "jinn setup" instead.`);
    process.exit(1);
  }

  const instances = loadInstances();

  if (instances.some((i) => i.name === name)) {
    console.error(`${RED}Error:${RESET} Instance "${name}" already exists.`);
    process.exit(1);
  }

  const assignedPort = port ?? nextAvailablePort(instances);
  const home = path.join(os.homedir(), `.${name}`);

  // Check if home dir already exists
  if (fs.existsSync(home)) {
    console.error(`${RED}Error:${RESET} Directory ${home} already exists. Remove it first or choose a different name.`);
    process.exit(1);
  }

  // Run setup in a subprocess with JINN_HOME set so paths.ts resolves correctly.
  // This avoids Node module caching issues — paths.ts evaluates fresh in the child.
  const jinnBin = process.argv[1];
  try {
    execFileSync(process.execPath, [jinnBin, "setup"], {
      env: { ...process.env, JINN_HOME: home, JINN_INSTANCE: name },
      stdio: "inherit",
    });
  } catch {
    console.error(`${RED}Error:${RESET} Failed to run setup for instance "${name}".`);
    process.exit(1);
  }

  // Patch the config with the correct port and portal name
  const configPath = path.join(home, "config.yaml");
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, "utf-8");
    config = config.replace(/port:\s*\d+/, `port: ${assignedPort}`);
    // Set portal name to capitalized instance name
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    if (config.includes("portal: {}")) {
      config = config.replace("portal: {}", `portal:\n  portalName: "${displayName}"`);
    }
    fs.writeFileSync(configPath, config);
  }

  // Register the instance
  const instance: Instance = {
    name,
    port: assignedPort,
    home,
    createdAt: new Date().toISOString(),
  };
  instances.push(instance);
  saveInstances(instances);

  console.log(`\n${GREEN}Instance "${name}" created successfully.${RESET}`);
  console.log(`  Home: ${DIM}${home}${RESET}`);
  console.log(`  Port: ${DIM}${assignedPort}${RESET}`);
  console.log(`\nStart with: ${DIM}jinn -i ${name} start${RESET}`);
  console.log(`Or:         ${DIM}jinn -i ${name} start --daemon${RESET}\n`);
}
