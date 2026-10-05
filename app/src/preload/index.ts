import { contextBridge, ipcRenderer } from "electron";

import { createApi, type IpcRendererLike } from "./api";

contextBridge.exposeInMainWorld("favorPrinter", createApi(ipcRenderer as unknown as IpcRendererLike));
