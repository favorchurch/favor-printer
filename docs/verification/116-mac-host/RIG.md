# Rig scripts used for the #116 Mac-host validation

These are the exact helper and scenario scripts that produced `EVIDENCE.md` and `logs/`. They ran from a scratch directory, never from tracked repo paths. Placeholders: `$SCR` is the scratch root outside the repo, `$T1` is this worktree, `<harness-only fake token>` replaces the throwaway local stub credential (it only exists in the local stub and the seeded throwaway profile).

Scenario drivers not listed below (`s1a.sh`, `s1b.sh`, `s2a.sh`, `s2c.sh`, `s3b.sh`, `s7.sh`, `s8b.sh`, `s9.sh`, `s10.sh`, `s11d.sh`, `s11c.sh`, `s11e.sh`) follow the same `start_seam` / `open_window` / `wait_ready` / quit pattern shown in `helpers2.sh`; each row of `EVIDENCE.md` states its exact fault injection command. The scenario 5, 4 and 6 drivers were inline shell with the same pattern (quit through the renderer IPC, then watch the bundle version).

## build.sh

```
#!/bin/bash
# usage: build.sh <srcdir> <version> <feedPort> <outdir>
set -u
SRC="$1"; VER="$2"; PORT="$3"; OUT="$4"
export CSC_KEYCHAIN="$HOME/Library/Keychains/favor-printer-beta6.keychain-db"
unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
mkdir -p "$OUT"
CFG="$SCR/builder-$VER.yml"
cat > "$CFG" <<YAML
extends: $SRC/electron-builder.yml
extraMetadata:
  version: $VER
directories:
  output: $OUT
publish:
  - provider: generic
    url: http://127.0.0.1:$PORT/
    channel: latest
mac:
  notarize: false
  target:
    - target: zip
      arch: [arm64]
    - target: dmg
      arch: [arm64]
dmg:
  sign: true
YAML
cd "$SRC" && [ -f dist/main.js ] || pnpm build
cd "$SRC" && pnpm exec electron-builder --config "$CFG" --mac --arm64 --publish never
echo BUILD_EXIT=$?
```

## feed.mjs

```
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [dir, port, log] = process.argv.slice(2);
http.createServer((req, res) => {
  const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const note = (st, extra = '') => fs.appendFileSync(log, new Date().toISOString() + ' ' + req.method + ' ' + new URL(req.url, 'http://x').pathname + ' ' + st + ' ' + extra + '\n');
  if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return note(404); }
  const size = fs.statSync(p).size; const range = req.headers.range;
  if (range) { const m = /bytes=(\d*)-(\d*)/.exec(range); const start = m[1] ? Number(m[1]) : 0; const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + size, 'content-length': end - start + 1, 'accept-ranges': 'bytes' }); note(206, range); fs.createReadStream(p, { start, end }).pipe(res); }
  else { res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' }); note(200); fs.createReadStream(p).pipe(res); }
}).listen(Number(port), '127.0.0.1', () => fs.appendFileSync(log, new Date().toISOString() + ' FEED_LISTENING ' + port + ' dir=' + path.basename(dir) + '\n'));
```

## sink.mjs

```
// Fake non-physical Zebra on loopback: counts and hashes what CUPS sends. Never logs content.
import net from 'node:net'; import fs from 'node:fs'; import crypto from 'node:crypto';
const [port, log] = process.argv.slice(2);
let n = 0;
net.createServer((s) => {
  const id = ++n; const h = crypto.createHash('sha256'); let bytes = 0;
  s.on('data', (d) => { bytes += d.length; h.update(d); });
  s.on('end', () => { fs.appendFileSync(log, new Date().toISOString() + ' CONN ' + id + ' bytes=' + bytes + ' sha256=' + h.digest('hex').slice(0, 16) + '\n'); s.end(); });
  s.on('error', () => {});
}).listen(Number(port), '127.0.0.1', () => fs.appendFileSync(log, new Date().toISOString() + ' SINK_LISTENING ' + port + '\n'));
```

## stub-cloud.ts

```
// Scratch control wrapper around RSVP's startStubCloud (rsvp@3712cac). Run with cwd = the rsvp worktree via tsx.
import http from "node:http";
import { startStubCloud } from "$SCR/rsvp-wt/src/lib/printing/relayTestHarness";

async function main() {
const cloud = await startStubCloud({ relayId: "t1-test-relay", token: "<harness-only fake token>", printerIds: ["t1-printer"] });
const ctl = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const out = (v: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  if (url.pathname === "/enqueue") { cloud.enqueue({ id: body.id, printerId: "t1-printer", label: "t1", zpl: body.zpl ?? "^XA^FO20,20^FDT1 SYNTHETIC^FS^XZ", host: "127.0.0.1", port: 9 }); return out({ ok: true }); }
  if (url.pathname === "/state") return out({ url: cloud.url, relayId: cloud.relayId, requests: cloud.requests.map((r) => ({ path: r.path, authorized: r.authorized })).slice(-400), reports: cloud.reports, heartbeats: cloud.heartbeats.length });
  if (url.pathname === "/address") { cloud.setPrinterAddress("t1-printer", "127.0.0.1", 9); return out({ ok: true }); }
  if (url.pathname === "/hold-sending") { (globalThis as any).relSending = cloud.holdSending(); return out({ ok: true }); }
  if (url.pathname === "/release-sending") { (globalThis as any).relSending?.(); return out({ ok: true }); }
  if (url.pathname === "/hold-reports") { (globalThis as any).relReports = cloud.holdReports(); return out({ ok: true }); }
  if (url.pathname === "/release-reports") { (globalThis as any).relReports?.(); return out({ ok: true }); }
  if (url.pathname === "/revoke") { cloud.revoke(); return out({ ok: true }); }
  if (url.pathname === "/restore") { cloud.restore(); return out({ ok: true }); }
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((r) => ctl.listen(Number(process.env.CTL_PORT), "127.0.0.1", () => r()));
cloud.setPrinterAddress("t1-printer", "127.0.0.1", 9);
console.log("STUB_READY cloud=" + cloud.url + " ctl=" + process.env.CTL_PORT + " relayId=" + cloud.relayId + " token=" + cloud.token);

}
main().catch((e) => { console.error(e); process.exit(1); });
```

## tap.js

```
(function(){
 const fs=require('fs'); const el=require('electron'); const LOG=process.env.T1_TAP_LOG;
 const w=(s)=>fs.appendFileSync(LOG,new Date().toISOString()+' '+s+'\n');
 w('TAP_ON main_pid='+process.pid+' app_version='+el.app.getVersion());
 const up=el.utilityProcess; const orig=up.fork.bind(up);
 up.fork=function(...a){ const c=orig(...a); w('RELAY_FORK'); globalThis.__t1child=c; c.on('spawn',()=>w('RELAY_SPAWN pid='+c.pid)); c.on('exit',(code)=>w('RELAY_EXIT code='+code));
  c.on('message',(m)=>{ try{ const s=(m&&(m.status||m.event))||m||{}; w('RELAY_MSG type='+(m&&m.type)+' state='+s.state+' reconciliation='+s.reconciliation+' inFlight='+s.inFlight+' cloud='+s.cloud+' counts='+JSON.stringify(s.counts)+' err='+s.lastError);}catch(e){} });
  return c; };
 for (const ev of ['before-quit','will-quit','quit']) el.app.on(ev,()=>w('APP_'+ev));
 for (const ev of ['checking-for-update','update-available','update-not-available','update-downloaded','error']) el.autoUpdater.on(ev,()=>w('NATIVE_UPDATER '+ev));
 process.on('exit',(c)=>w('MAIN_EXIT code='+c));
 return 'tap installed';
})()
```

## seed-tap.js

```
(function(){
 const fs=require('fs'); const path=require('path'); const el=require('electron');
 el.app.whenReady().then(()=>{
  try{
   const ok=el.safeStorage.isEncryptionAvailable();
   const dir=el.app.getPath('userData');
   const creds=JSON.stringify({relayId:process.env.T1_RELAY_ID, token:process.env.T1_RELAY_TOKEN});
   if(ok){ fs.mkdirSync(dir,{recursive:true,mode:0o700}); fs.writeFileSync(path.join(dir,'relay-token.bin'), el.safeStorage.encryptString(creds), {mode:0o600}); }
   fs.appendFileSync(process.env.T1_TAP_LOG, new Date().toISOString()+' SEED encryption='+ok+' written='+ok+'\n');
  }catch(e){ fs.appendFileSync(process.env.T1_TAP_LOG, new Date().toISOString()+' SEED_ERR '+e.message+'\n'); }
 });
 return 'seed armed';
})()
```

## launch.sh

```
#!/bin/bash
# launch.sh <app> <home> <taplog> <tapexpr> <apiUrl|-> [extra app args...]
APP="$1"; H="$2"; TAPLOG="$3"; TAPEXPR="$4"; API="$5"; shift 5
mkdir -p "$H/Library"; [ -e "$H/Library/Keychains" ] || ln -sfn "$HOME/Library/Keychains" "$H/Library/Keychains"
ENVV=(HOME="$H" T1_TAP_LOG="$TAPLOG" T1_RELAY_ID=t1-test-relay T1_RELAY_TOKEN=<harness-only fake token>)
[ "$API" != "-" ] && ENVV+=(FAVOR_PRINTER_TEST_API_URL="$API")
PIDF="$H/app.pid"
( env "${ENVV[@]}" "$APP/Contents/MacOS/Favor Printer" --inspect-brk=19230 --remote-debugging-port=19300 "$@" > "$H/app.stdout" 2>&1 < /dev/null & echo $! > "$PIDF" )
perl -e 'alarm 40; exec @ARGV' node $T1/.scratch/116-mac/cdp-brk.mjs 19230 "$TAPEXPR"
echo "launched pid $(cat $PIDF)"
```

## helpers.sh

```
#!/bin/bash
# helpers: source this file
inst() { # inst <srcApp> <name>
  mkdir -p "$SCR/inst/$2"; ditto "$1" "$SCR/inst/$2/Favor Printer.app"; echo "$SCR/inst/$2/Favor Printer.app"; }
mkhome() { # mkhome <name> <withToken 0|1>
  H="$SCR/home-$1"; mkdir -p "$H/Library/Application Support/Favor Printer"; ln -sfn "$HOME/Library/Keychains" "$H/Library/Keychains"
  cp $SCR/seed/prefs.json "$H/Library/Application Support/Favor Printer/prefs.json"
  [ "$2" = "1" ] && cp $SCR/seed/relay-token.bin "$H/Library/Application Support/Favor Printer/relay-token.bin"
  echo "$H"; }
waitlog() { # waitlog <file> <regex> <timeoutSec>
  for i in $(seq 1 $3); do grep -Eq "$2" "$1" 2>/dev/null && return 0; sleep 1; done; return 1; }
snap() { # snap  -> prints snapshot JSON from the setup window renderer
  node $T1/.scratch/116-mac/cdp-page.mjs 19300 $T1/.scratch/116-mac/snap-expr.js; }
```

## helpers2.sh

```
start_seam() { # start_seam <name> <withToken> -> sets APP H TL API
  APP=$(inst "$SCR/out-seam-11b/mac-arm64/Favor Printer.app" $1); H=$(mkhome $1 $2); TL=$SCR/rig/$1-tap.log; : > $TL
  API=$(curl -s http://127.0.0.1:19400/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).url))")
  bash $T1/.scratch/116-mac/launch.sh "$APP" "$H" $TL $T1/.scratch/116-mac/tap.js "$API" > /dev/null; }
open_window() { HOME=$H "$APP/Contents/MacOS/Favor Printer" > /dev/null 2>&1 & sleep 3; }
snapval() { snap | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(JSON.parse(s).value);console.log(JSON.stringify({version:o.version,update:o.update,status:o.status.headline,enrolled:o.enrolled,recentJobs:o.recentJobs}))}catch(e){console.log('SNAP_ERR '+s.slice(0,100))}})"; }
wait_ready() { for i in $(seq 1 $1); do snapval | grep -q '"kind":"ready"' && return 0; sleep 2; done; return 1; }
relay_pid() { grep RELAY_SPAWN $TL | tail -1 | sed 's/.*pid=//'; }
bundle_version() { plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist"; }
kill_relaunched() { P=$(pgrep -f "inst/$1/Favor Printer.app/Contents/MacOS/Favor Printer" | head -1); [ -n "$P" ] && { kill -TERM $P; sleep 4; ps -p $P > /dev/null && kill -9 $P; echo "relaunched app pid $P stopped (HOME was $(ps eww -p $P 2>/dev/null | tr ' ' '\n' | grep '^HOME=' ))"; }; }
```

## cdp-brk.mjs

```
// usage: node cdp-brk.mjs <port> <expr-file>   (target started with --inspect-brk)
import fs from 'node:fs';
const [port, exprFile] = process.argv.slice(2);
const expr = fs.readFileSync(exprFile, 'utf8');
let list;
for (let i = 0; i < 100; i++) { try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); if (list[0]) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let n = 0; const pending = new Map(); let pausedResolve; const paused = new Promise(r => pausedResolve = r);
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Debugger.paused') pausedResolve(d.params); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const call = (method, params = {}) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await call('Debugger.enable');
await call('Runtime.runIfWaitingForDebugger');
const p = await Promise.race([paused, new Promise(r => setTimeout(() => r(null), 15000))]);
if (!p) { console.log('NO_PAUSE'); process.exit(2); }
const r = await call('Debugger.evaluateOnCallFrame', { callFrameId: p.callFrames[0].callFrameId, expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result?.result ?? r.error ?? r));
await call('Debugger.resume');
ws.close();
```

## cdp-page.mjs

```
// usage: node cdp-page.mjs <port> <expr-file>  -> evaluates in the first "page" target (setup window renderer)
import fs from 'node:fs';
const [port, exprFile] = process.argv.slice(2);
const expr = fs.readFileSync(exprFile, 'utf8');
let page;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); page = l.find((t) => t.type === 'page'); if (page) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
if (!page) { console.log('NO_PAGE'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { console.log(JSON.stringify(d.result?.result ?? d.error)); ws.close(); } };
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
```

## snap-expr.js

```
window.favorPrinter.getSnapshot().then(s => JSON.stringify(s))
```

## quit-expr.js

```
window.favorPrinter.quit().then(()=> 'quit-invoked').catch(e=>'quit-error '+e.message)
```

## inject-stopped.js

```
(function(){ globalThis.__t1child.emit('message', {type:'stopped'}); return 'bare stopped acknowledgement injected into the supervisor message handler'; })()
```

## tapsum.mjs

```
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const out = []; let last = null, n = 0, t0 = '';
const flush = () => { if (last !== null) out.push(t0 + ' ' + last + (n > 1 ? '  (x' + n + ')' : '')); };
for (const l of lines) { const m = /^(\S+) (.*)$/.exec(l); if (!m) continue; const body = m[2]; if (body === last) { n++; continue; } flush(); last = body; n = 1; t0 = m[1].slice(11, 23); }
flush(); console.log(out.join('\n'));
```

## spool-view.sh

```
H=${1:-$SCR/home-sc8}; SP="$H/Library/Application Support/Favor Printer/spool"
ls -la "$SP" | cut -c1-100
node -e "const fs=require('fs'),cr=require('crypto');const d=process.argv[1];for(const f of fs.readdirSync(d).sort()){const p=d+'/'+f;const st=fs.statSync(p);if(!st.isFile())continue;let info='';if(f.endsWith('.json')){try{const j=JSON.parse(fs.readFileSync(p,'utf8'));info=' stage='+j.stage+' hasZpl='+('zpl' in j)+(j.outcome?' outcome='+j.outcome:'')}catch(e){info=' unparsable'}}console.log('  name_sha='+cr.createHash('sha256').update(f).digest('hex').slice(0,8)+' ext='+f.split('.').slice(-1)[0]+' size='+st.size+info)}" "$SP"
curl -s http://127.0.0.1:19400/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const c={};for(const r of o.requests){const k=r.path.replace(/jobs\/[^/]+/,'jobs/<id>');c[k]=(c[k]||0)+1}console.log('stub requests(last400):',JSON.stringify(c),'reports:',JSON.stringify(o.reports))})"
tail -2 $SCR/rig/sink.log
```

## seam-patch.cjs

```
const fs=require('fs');
const f='$SCR/seam-src/app/src/main/shell/controller.ts';
let s=fs.readFileSync(f,'utf8');
const a='  const apiUrl = deps.apiUrl ?? "https://rsvp.favor.church";';
const a2='  const apiUrl = deps.apiUrl ?? testApiUrl(process.env.FAVOR_PRINTER_TEST_API_URL) ?? "https://rsvp.favor.church";';
if(!s.includes(a)) throw new Error('anchor a');
s=s.replace(a,a2);
const b='    apiUrl: deps.apiUrl,\n  });\n\n  const backlogMonitor';
if(!s.includes(b)) throw new Error('anchor b');
s=s.replace(b,'    apiUrl,\n  });\n\n  const backlogMonitor');
const c='export function createAppController(';
const fn='/** TEST SEAM (never committed): accepts only an http://127.0.0.1:<port> or http://localhost:<port> origin, ignores anything else. */\nfunction testApiUrl(raw: string | undefined): string | undefined {\n  if (!raw) return undefined;\n  try {\n    const url = new URL(raw);\n    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";\n    if (url.protocol !== "http:" || !loopback || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;\n    return url.origin;\n  } catch {\n    return undefined;\n  }\n}\n\n';
if(!s.includes(c)) throw new Error('anchor c');
s=s.replace(c,fn+c);
fs.writeFileSync(f,s);
```

## s1c.sh

```
source $T1/.scratch/116-mac/helpers.sh; source $T1/.scratch/116-mac/helpers2.sh
APP="$SCR/inst/sc3/Favor Printer.app"; H=$SCR/home-sc3
echo "bundle: $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
echo "persisted spool from the earlier (quit-aborted) process:"; bash $T1/.scratch/116-mac/spool-view.sh $H | head -6
curl -s -X POST http://127.0.0.1:19400/hold-sending > /dev/null
TL=$SCR/rig/sc3-tap-s1.log; : > $TL
API=$(curl -s http://127.0.0.1:19400/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).url))")
bash $T1/.scratch/116-mac/launch.sh "$APP" "$H" $TL $T1/.scratch/116-mac/tap.js "$API" > /dev/null
waitlog $TL "RELAY_MSG.*cloud=ok" 30 && echo "relay up (new process, no job claimed by this run yet)"
open_window; wait_ready 40 && echo UPDATE_READY; snapval
sleep 6
echo "relay status samples: $(grep -o 'reconciliation=[a-z]* inFlight=[a-z]* cloud=[a-z]* counts={[^}]*}' $TL | sort | uniq -c | sort -rn | head -4 | tr '\n' '|')"
echo "bundle before quit: $(bundle_version)"; echo "QUIT_REQUEST $(date -u +%T)"
node $T1/.scratch/116-mac/cdp-page.mjs 19300 $T1/.scratch/116-mac/quit-expr.js
for i in $(seq 1 40); do pgrep -f "inst/sc3/Favor Printer.app/Contents/MacOS/Favor Printer" > /dev/null || { echo "app gone after ~$i s"; break; }; sleep 1; done
sleep 25
echo "bundle after quit: $(bundle_version)"
node $T1/.scratch/116-mac/tapsum.mjs $TL | tail -7 | cut -c1-170
echo "spool after:"; bash $T1/.scratch/116-mac/spool-view.sh $H | head -6
curl -s -X POST http://127.0.0.1:19400/release-sending > /dev/null
```

## s3c.sh

```
source $T1/.scratch/116-mac/helpers.sh; source $T1/.scratch/116-mac/helpers2.sh
echo "+ cancel -a FP_T1_Test_Queue   (clears test-queue leftovers from aborted lp runs)"; cancel -a FP_T1_Test_Queue; sleep 1
curl -s -X POST http://127.0.0.1:19400/release-sending > /dev/null
start_seam sc3c 1
waitlog $TL "RELAY_MSG.*reconciliation=complete" 30 && echo "relay up"
open_window; wait_ready 40 && echo UPDATE_READY; snapval
echo "sink conns before: $(grep -c CONN $SCR/rig/sink.log)"
RP=$(relay_pid)
curl -s -X POST http://127.0.0.1:19400/hold-sending > /dev/null
curl -s -X POST http://127.0.0.1:19400/enqueue -d '{"id":"t1-job-s3c-a"}' > /dev/null
for i in $(seq 1 80); do LP=$(pgrep -P $RP -f "lp -d FP_T1_Test_Queue" | head -1); [ -n "$LP" ] && break; sleep 0.25; done
echo "relay's lp child pid=$LP"
echo "+ kill -STOP $LP   (CUPS hand-off stalls while bytes are being written)"; kill -STOP $LP
curl -s -X POST http://127.0.0.1:19400/release-sending > /dev/null
sleep 1.5
echo "relay state: $(tail -1 $TL | cut -c14-110)"
echo "bundle before: $(bundle_version)"; echo "QUIT_REQUEST $(date -u +%T)"
node $T1/.scratch/116-mac/cdp-page.mjs 19300 $T1/.scratch/116-mac/quit-expr.js
sleep 4
echo "4s after quit: app alive=$(pgrep -f 'inst/sc3c/Favor Printer.app/Contents/MacOS/Favor Printer' | wc -l | tr -d ' ') bundle=$(bundle_version) relay: $(tail -1 $TL | cut -c14-110)"
echo "sink conns while stalled: $(grep -c CONN $SCR/rig/sink.log)"
echo "RESUME_LP $(date -u +%T)"; kill -CONT $LP
for i in $(seq 1 45); do [ "$(bundle_version)" = "0.3.3-test.12" ] && { echo "bundle became test.12 after ~$i s"; break; }; sleep 1; done
sleep 6
echo "bundle after: $(bundle_version)"
echo "sink:"; tail -2 $SCR/rig/sink.log
echo "CUPS pending: $(lpstat -o FP_T1_Test_Queue | wc -l | tr -d ' ')"; lpstat -W completed -o FP_T1_Test_Queue 2>&1 | tail -2
curl -s http://127.0.0.1:19400/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('stub reports:',JSON.stringify(o.reports))})"
node $T1/.scratch/116-mac/tapsum.mjs $TL | tail -14
kill_relaunched sc3c
bash $T1/.scratch/116-mac/spool-view.sh $SCR/home-sc3c
```

## s11e.sh

```
source $T1/.scratch/116-mac/helpers.sh; source $T1/.scratch/116-mac/helpers2.sh
curl -s -X POST http://127.0.0.1:19400/release-sending > /dev/null
start_seam sc11e 1
waitlog $TL "RELAY_MSG.*reconciliation=complete" 30 && echo "relay up, reconciliation complete"
open_window; wait_ready 40 && echo UPDATE_READY
RP=$(relay_pid)
curl -s -X POST http://127.0.0.1:19400/hold-sending > /dev/null
curl -s -X POST http://127.0.0.1:19400/enqueue -d '{"id":"t1-job-s11e-a"}' > /dev/null
for i in $(seq 1 80); do LP=$(pgrep -P $RP -f "lp -d FP_T1_Test_Queue" | head -1); [ -n "$LP" ] && break; sleep 0.25; done
echo "+ kill -STOP lp=$LP (write phase stalls)"; kill -STOP $LP
curl -s -X POST http://127.0.0.1:19400/release-sending > /dev/null
sleep 1.5
echo "relay status: $(tail -1 $TL | cut -c14-110)"
echo "bundle before: $(bundle_version)"; echo "QUIT_REQUEST $(date -u +%T)"
node $T1/.scratch/116-mac/cdp-page.mjs 19300 $T1/.scratch/116-mac/quit-expr.js
sleep 0.7
echo "+ kill -STOP relay=$RP (relay frozen with its last status showing inFlight=true)"; kill -STOP $RP
sleep 13
echo "13s after quit: app alive=$(pgrep -f 'inst/sc11e/Favor Printer.app/Contents/MacOS/Favor Printer' | wc -l | tr -d ' ') bundle=$(bundle_version) (stop wait of 10s has elapsed: abandoned, not killed)"
tail -2 ~/Library/Logs/favor-printer/main.log | cut -c1-150
ps -p $RP -o pid=,stat= | sed 's/^/relay still present: /'
echo "+ kill -9 $RP at $(date -u +%T) (unexpected relay exit after the abandoned wait)"; kill -9 $RP
for i in $(seq 1 25); do pgrep -f "inst/sc11e/Favor Printer.app/Contents/MacOS/Favor Printer" > /dev/null || { echo "app gone after ~$i s"; break; }; sleep 1; done
sleep 30
echo "bundle after 30s: $(bundle_version)"; pgrep -fl "inst/sc11e" | grep -v ShipIt | cut -c1-100
echo "+ cleanup: kill -9 $LP (stopped lp left by the test); cancel -a FP_T1_Test_Queue"; kill -9 $LP 2>/dev/null; cancel -a FP_T1_Test_Queue
node $T1/.scratch/116-mac/tapsum.mjs $TL | tail -9
bash $T1/.scratch/116-mac/spool-view.sh $SCR/home-sc11e | head -9
```

## s9.sh

```
source $T1/.scratch/116-mac/helpers.sh; source $T1/.scratch/116-mac/helpers2.sh
curl -s -X POST http://127.0.0.1:19400/release-sending > /dev/null
APP=$(inst "$SCR/out-seam-11b/mac-arm64/Favor Printer.app" sc9); H=$(mkhome sc9 1)
SP="$H/Library/Application Support/Favor Printer/spool"; mkdir -p "$SP"; chmod 700 "$SP"
printf 'not json at all {{{' > "$SP/t1-corrupt-record.json"
printf 'marker without an entry' > "$SP/t1-orphan-job.send"
printf 'stray bytes' > "$SP/t1-unknown-file.dat"
printf '{"stage":"claimed"' > "$SP/t1-orphan.json.4242.11111111-2222-3333-4444-555555555555.tmp"
printf 'temp-looking but not the swept pattern' > "$SP/t1-other.tmp"
echo "spool BEFORE first launch (name hash, size, content hash):"; (cd "$SP" && for f in $(ls -A | sort); do echo "  $(echo $f | shasum -a 256 | cut -c1-8) $(wc -c < "$f" | tr -d ' ')B $(shasum -a 256 < "$f" | cut -c1-12)"; done)
for round in 1 2; do
  TL=$SCR/rig/sc9-tap-$round.log; : > $TL
  API=$(curl -s http://127.0.0.1:19400/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).url))")
  bash $T1/.scratch/116-mac/launch.sh "$APP" "$H" $TL $T1/.scratch/116-mac/tap.js "$API" > /dev/null
  waitlog $TL "RELAY_MSG.*cloud=ok" 30 && echo "round $round: relay up"
  open_window; wait_ready 40 && echo "round $round: UPDATE_READY"
  sleep 12
  echo "round $round: reconciliation values seen in 12s: $(grep -o 'reconciliation=[a-z]*' $TL | sort | uniq -c | tr '\n' ' ')"
  echo "round $round: spool AFTER (name hash, size, content hash):"; (cd "$SP" && for f in $(ls -A | sort); do echo "  $(echo $f | shasum -a 256 | cut -c1-8) $(wc -c < "$f" | tr -d ' ')B $(shasum -a 256 < "$f" | cut -c1-12)  ext=${f##*.}"; done)
  echo "round $round: bundle before quit: $(bundle_version)"; node $T1/.scratch/116-mac/cdp-page.mjs 19300 $T1/.scratch/116-mac/quit-expr.js
  for i in $(seq 1 30); do pgrep -f "inst/sc9/Favor Printer.app/Contents/MacOS/Favor Printer" > /dev/null || { echo "round $round: app gone after ~$i s"; break; }; sleep 1; done
  sleep 25
  echo "round $round: bundle after quit: $(bundle_version)"
  node $T1/.scratch/116-mac/tapsum.mjs $TL | tail -6 | cut -c1-170
done
tail -3 ~/Library/Logs/favor-printer/main.log | cut -c1-140
```

## s2c.sh

```
source $T1/.scratch/116-mac/helpers.sh; source $T1/.scratch/116-mac/helpers2.sh
start_seam sc2c 1
waitlog $TL "RELAY_MSG.*reconciliation=complete" 30 && echo "relay up, reconciliation complete"
open_window; wait_ready 40 && echo UPDATE_READY
SP="$H/Library/Application Support/Favor Printer/spool"
M=$(wc -l < $TL)
echo "+ chmod +a 'user:$(id -un) deny list,search' <spool dir>  (ACL deny; the relay re-asserts mode 0700 each cycle but cannot remove an ACL) at $(date -u +%T)"
chmod +a "user:$(id -un) deny list,search" "$SP"
sleep 10
echo "reconciliation values since ACL: $(tail -n +$((M+1)) $TL | grep -o 'reconciliation=[a-z]*' | sort | uniq -c | tr '\n' ' ')"
echo "last relay status: $(tail -1 $TL | cut -c14-140)"
echo "bundle before: $(bundle_version)"; echo "QUIT_REQUEST $(date -u +%T)"
node $T1/.scratch/116-mac/cdp-page.mjs 19300 $T1/.scratch/116-mac/quit-expr.js
for i in $(seq 1 40); do pgrep -f "inst/sc2c/Favor Printer.app/Contents/MacOS/Favor Printer" > /dev/null || { echo "app gone after ~$i s"; break; }; sleep 1; done
sleep 25
echo "bundle after: $(bundle_version)"
echo "+ chmod -a (restore) then show ACL state"; chmod -a "user:$(id -un) deny list,search" "$SP"; ls -lde "$SP" | head -3
node $T1/.scratch/116-mac/tapsum.mjs $TL | tail -9 | cut -c1-170
tail -3 ~/Library/Logs/favor-printer/main.log | cut -c1-150
```

## s10.sh

```
source $T1/.scratch/116-mac/helpers.sh; source $T1/.scratch/116-mac/helpers2.sh
start_seam sc10 1
waitlog $TL "RELAY_MSG.*reconciliation=complete" 30 && echo "relay up, reconciliation complete"
open_window; wait_ready 40 && echo UPDATE_READY
SP="$H/Library/Application Support/Favor Printer/spool"
echo "+ chmod +a 'user:$(id -un) deny delete' <spool>/.relay.lock   (lock release will fail with a permission error) at $(date -u +%T)"
chmod +a "user:$(id -un) deny delete" "$SP/.relay.lock"
echo "bundle before: $(bundle_version)"; echo "QUIT_REQUEST $(date -u +%T)"
node $T1/.scratch/116-mac/cdp-page.mjs 19300 $T1/.scratch/116-mac/quit-expr.js
for i in $(seq 1 40); do pgrep -f "inst/sc10/Favor Printer.app/Contents/MacOS/Favor Printer" > /dev/null || { echo "app gone after ~$i s"; break; }; sleep 1; done
sleep 25
echo "bundle after: $(bundle_version)"
echo "+ chmod -a (restore)"; chmod -a "user:$(id -un) deny delete" "$SP/.relay.lock"; ls -le "$SP" | head -5
echo "spool after (lock left in place by the failed release):"; bash $T1/.scratch/116-mac/spool-view.sh $H | head -5
node $T1/.scratch/116-mac/tapsum.mjs $TL | tail -9 | cut -c1-170
tail -4 ~/Library/Logs/favor-printer/main.log | cut -c1-150
```

