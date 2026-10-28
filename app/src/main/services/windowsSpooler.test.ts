import { describe, expect, it, vi } from "vitest";
import { parseParentMessage } from "../../../../vendor/relay/embeddedProtocol";
import { loadRelayConfig } from "../../../../vendor/relay/config";
import { createWindowsSpoolerTransport, validateLocalWindowsScriptPath, validateWindowsQueueName } from "../../../../vendor/relay/windowsSpooler";
import type { ProcessExit, SpawnedProcess, Spawner } from "../../../../vendor/relay/cups";

const SHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const HELPER = "C:\\Program Files\\Favor Printer\\resources\\print-raw.ps1";
const QUEUE = "ZDesigner ZD421-203dpi ZPL";
const TARGET = { host: "127.0.0.1", port: 9100 };
const OK: ProcessExit = { code: 0, signal: null, stdout: "FAVOR_SPOOL_ACCEPTED\n", stderr: "", timedOut: false };

function fake(opts: { exit?: Partial<ProcessExit>; startError?: Error; finishError?: Error } = {}) {
  const calls: Array<{ file: string; args: readonly string[]; data: Buffer | null; cancelled: boolean }> = [];
  const spawner: Spawner = (file, args): SpawnedProcess => {
    const entry = { file, args, data: null as Buffer | null, cancelled: false };
    calls.push(entry);
    const started = opts.startError ? Promise.reject(opts.startError) : Promise.resolve();
    started.catch(() => undefined);
    return {
      started,
      finish: async (data) => {
        entry.data = data;
        if (opts.finishError) throw opts.finishError;
        return { ...OK, ...opts.exit };
      },
      cancel: () => { entry.cancelled = true; },
    };
  };
  return { calls, spawner };
}
const transport = (spawner: Spawner, platform: NodeJS.Platform = "win32") =>
  createWindowsSpoolerTransport({ queue: QUEUE, scriptPath: HELPER, powershellCommand: SHELL, spawner, platform });

describe("Windows RAW spooler transport", () => {
  it("validates local queue names and absolute non-UNC script paths", () => {
    expect(validateWindowsQueueName(QUEUE)).toBe(QUEUE);
    for (const invalid of ["", " ", "../queue", "bad;exit", "-Danger", "Foo\\Bar", " a", "q\nname", "🚨", "q".repeat(128)]) {
      expect(() => validateWindowsQueueName(invalid)).toThrow();
    }
    expect(validateLocalWindowsScriptPath(HELPER)).toBe(HELPER);
    for (const invalid of ["print.ps1", "\\\\server\\share\\print.ps1", "C:\\bad\nscript.ps1"]) {
      expect(() => validateLocalWindowsScriptPath(invalid)).toThrow();
    }
  });
  it("uses fixed argv and sends exact UTF-8 ZPL only after approval", async () => {
    const h = fake();
    const zpl = "^XA^FDJosé & Ana 日本^FS^XZ";
    const gate = vi.fn(async () => { expect(h.calls[0].data).toBeNull(); return true; });
    expect(await transport(h.spawner).send(TARGET, zpl, { beforeWrite: gate })).toEqual({ kind: "sent" });
    expect(gate).toHaveBeenCalledOnce();
    expect(h.calls[0].file).toBe(SHELL);
    expect(h.calls[0].args).toEqual(["-NoLogo","-NoProfile","-NonInteractive","-File",HELPER,"-Action","Print","-PrinterName",QUEUE]);
    expect(h.calls[0].data?.toString("utf8")).toBe(zpl);
  });
  it("never launches helper on another platform", async () => {
    const h = fake();
    expect((await transport(h.spawner,"darwin").send(TARGET,"^XA^XZ",{beforeWrite:vi.fn()})).kind).toBe("unsent");
    expect(h.calls).toHaveLength(0);
  });
  it("classifies definite spawn failure as unsent without entering sending gate", async () => {
    const h = fake({ startError: new Error("ENOENT") }); const gate = vi.fn();
    expect((await transport(h.spawner).send(TARGET,"^XA^XZ",{beforeWrite:gate})).kind).toBe("unsent");
    expect(gate).not.toHaveBeenCalled();
  });
  it("aborts without bytes if sending gate declines or throws", async () => {
    for (const gate of [async()=>false, async()=>{throw Error("blocked")}]) {
      const h = fake(); expect((await transport(h.spawner).send(TARGET,"^XA^XZ",{beforeWrite:gate})).kind).toBe("aborted");
      expect(h.calls[0]).toMatchObject({data:null,cancelled:true});
    }
  });
  it("never automatically retries uncertain post-gate outcomes", async () => {
    for (const exit of [{code:1},{code:0,stdout:"unknown"},{code:null,timedOut:true},{code:0,stdout:"FAVOR_SPOOL_ACCEPTED\nnoise"}]) {
      const h=fake({exit});
      expect((await transport(h.spawner).send(TARGET,"^XA^XZ",{beforeWrite:async()=>true})).kind).toBe("ambiguous");
    }
    const h=fake({finishError:Error("partial")});
    expect((await transport(h.spawner).send(TARGET,"^XA^XZ",{beforeWrite:async()=>true})).kind).toBe("ambiguous");
  });
  it("probes local queue without job bytes or physical readiness claim", async () => {
    const h=fake({exit:{stdout:"FAVOR_QUEUE_FOUND\n"}});
    expect(await transport(h.spawner).probe(TARGET)).toEqual({reachable:true,status:"status_unknown"});
    expect(h.calls[0].args).toContain("Probe");
    expect(h.calls[0].data?.length).toBe(0);
  });
  it("supports typed IPC transport, keeping CUPS and TCP compatible",()=>{
    const common={apiUrl:"https://rsvp.favor.church",relayId:"r",token:"t",spoolDir:"C:\\tmp",appVersion:"1",osVersion:"Windows"};
    expect(parseParentMessage({type:"start",options:{...common,transport:{kind:"windows",queue:QUEUE,scriptPath:HELPER}}})).not.toBeNull();
    expect(parseParentMessage({type:"start",options:{...common,transport:{kind:"windows",queue:QUEUE}}})).toBeNull();
    expect(parseParentMessage({type:"start",options:{...common,transport:{kind:"cups",queue:"Zebra"}}})).not.toBeNull();
  });
  it("requires one printer UUID in standalone Windows config",()=>{
    const base={RELAY_API_URL:"https://rsvp.favor.church",RELAY_ID:"r",RELAY_TOKEN:"t",RELAY_PRINTER_IDS:"p1"};
    const env={...base,RELAY_TRANSPORT:"windows",RELAY_WINDOWS_QUEUE:QUEUE,RELAY_WINDOWS_SCRIPT_PATH:HELPER};
    expect(loadRelayConfig(env)).toMatchObject({transport:"windows",windowsQueue:QUEUE,windowsScriptPath:HELPER});
    expect(()=>loadRelayConfig({...env,RELAY_PRINTER_IDS:"p1,p2"})).toThrow(/exactly one/);
    expect(()=>loadRelayConfig({...base,RELAY_TRANSPORT:"windows"})).toThrow(/RELAY_WINDOWS_QUEUE/);
  });
});
