import { createServer, type Server } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

const desktopBridge = `
(async () => {
  const desktop = window.snowstormDesktop;
  if (!desktop) return;
  for (let attempt = 0; attempt < 200 && typeof window.loadFileFromParentEffect !== 'function'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const initial = await desktop.initialEffect();
  if (!initial || typeof window.loadFileFromParentEffect !== 'function') return;
  window.loadFileFromParentEffect(initial.raw, initial.textureDataUrl || undefined);
  const save = async () => {
    const raw = window.generateFileForParentEffect();
    const result = await desktop.saveEffect(raw);
    button.textContent = result.ok ? 'Saved safely' : 'Save failed';
    setTimeout(() => { button.textContent = 'Save safely'; }, 1800);
  };
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Save safely';
  button.title = 'Save while preserving Blockbuster extensions';
  button.style.cssText = 'position:fixed;right:14px;bottom:44px;z-index:10000;padding:7px 10px;background:#3c78d8;color:white;border:0;border-radius:4px;cursor:pointer';
  button.addEventListener('click', save);
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  });
  document.body.appendChild(button);
})();`;

const contentSecurityPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export interface SnowstormHost {
  url: string;
  close(): Promise<void>;
}

export async function startSnowstormHost(snowstormDirectory: string, includeDesktopBridge = false, includeAutomationBridge = false): Promise<SnowstormHost> {
  const canonicalSnowstormDirectory = await realpath(snowstormDirectory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/bridge.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(desktopBridge);
        return;
      }
      const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      const requestedTarget = path.resolve(canonicalSnowstormDirectory, requested);
      if (!isInside(canonicalSnowstormDirectory, requestedTarget)) {
        response.writeHead(403).end();
        return;
      }
      const target = await realpath(requestedTarget);
      if (!isInside(canonicalSnowstormDirectory, target)) {
        response.writeHead(403).end();
        return;
      }
      const metadata = await stat(target);
      if (!metadata.isFile()) {
        response.writeHead(404).end();
        return;
      }
      let content = await readFile(target);
      if (includeAutomationBridge && requested === "dist/app.js") {
        const source = content.toString("utf8");
        const hook = "window.Emitter=Pw,";
        if (source.split(hook).length !== 2) throw new Error("Pinned Snowstorm automation bridge no longer matches dist/app.js.");
        content = Buffer.from(source.replace(hook, "window.__preview=Qx,window.__engine=_x,window.Emitter=Pw,"));
      }
      if (requested === "index.html") {
        const bridge = includeDesktopBridge ? '<script src="/bridge.js"></script>' : "";
        content = Buffer.from(content.toString("utf8")
          .replace("</head>", `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"></head>`)
          .replace("</body>", `${bridge}</body>`));
      }
      response.writeHead(200, {
        "content-type": mimeTypes[path.extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Snowstorm host did not expose a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
