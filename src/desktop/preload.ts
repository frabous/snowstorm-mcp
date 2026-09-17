import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("snowstormDesktop", {
  initialEffect: () => ipcRenderer.invoke("snowstorm:initial-effect"),
  saveEffect: (raw: string) => ipcRenderer.invoke("snowstorm:save-effect", raw)
});
