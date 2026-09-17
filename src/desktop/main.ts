import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { loadConfig, snowstormRoot } from "../config.js";
import { mergeSnowstormExport, ParticleStore } from "../particle-store.js";
import { startSnowstormHost, type SnowstormHost } from "../snowstorm-host.js";
import type { JsonObject, ProjectConfig } from "../types.js";
import { validateParticle } from "../validator.js";
import { particleTexture, resolveTexturePath } from "../texture.js";

declare global {
  interface Window {
    snowstormDesktop?: {
      initialEffect(): Promise<{ raw: string; textureDataUrl?: string } | null>;
      saveEffect(raw: string): Promise<{ ok: boolean; error?: string }>;
    };
  }
}

function isParticleArgument(value: string): boolean {
  return value.toLowerCase().endsWith(".particle.json");
}

async function textureDataUrl(document: JsonObject, config: ProjectConfig): Promise<string | undefined> {
  const texture = particleTexture(document);
  if (typeof texture !== "string" || !texture.includes(":")) return undefined;
  try {
    return `data:image/png;base64,${(await readFile(resolveTexturePath(texture, config))).toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const store = new ParticleStore(config);
  const requested = process.argv.find(isParticleArgument);
  const file = requested ? path.relative(config.particlesRoot, requested).replaceAll(path.sep, "/") : (await store.list())[0]?.file;
  if (!file) throw new Error("No particle file is available to open.");
  let current = await store.readRaw(file);
  let saveQueue = Promise.resolve();
  const host = await startSnowstormHost(snowstormRoot(path.dirname(config.configPath)), true);
  const isTrustedSender = (url: string) => {
    try {
      return new URL(url).origin === host.url;
    } catch {
      return false;
    }
  };

  ipcMain.handle("snowstorm:initial-effect", async (event) => {
    if (!event.senderFrame || !isTrustedSender(event.senderFrame.url)) throw new Error("Untrusted renderer requested particle data.");
    return {
      raw: current.raw,
      textureDataUrl: await textureDataUrl(current.document, config)
    };
  });
  ipcMain.handle("snowstorm:save-effect", async (event, raw: string) => {
    if (!event.senderFrame || !isTrustedSender(event.senderFrame.url)) return { ok: false, error: "Untrusted renderer attempted a save." };
    const save = saveQueue.then(async () => {
      try {
        const generated = JSON.parse(raw) as JsonObject;
        const merged = mergeSnowstormExport(current.document, generated);
        const validation = await validateParticle(merged, config, file);
        if (!validation.valid) return { ok: false, error: validation.issues.map((issue) => issue.message).join(" ") };
        const write = await store.write(file, merged, current.digest);
        current = { raw, document: merged, digest: write.digest };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
    saveQueue = save.then(() => undefined, () => undefined);
    return save;
  });

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: `Snowstorm MCP - ${file}`,
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedSender(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(`${host.url}/index.html`);
  app.on("before-quit", () => { void host.close(); });
}

app.whenReady().then(main).catch((error: unknown) => {
  console.error(error);
  app.quit();
});
