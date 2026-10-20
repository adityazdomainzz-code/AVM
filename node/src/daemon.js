// AVM Node Daemon - LXC containers + KVM virtual machines via Incus
'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const incus = require('./incus');
const net = require('./net');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(CONFIG_FILE)) { console.error('[avm-node] config.json missing - run install.sh'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const PORT = cfg.port || 8090;
const BRIDGE = cfg.bridge || 'incusbr0';
const DATA_DIR = cfg.dataDir || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistent state ----------
let S = { vms: {}, ports: [], ips: [] };
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
function save() { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S, null, 2)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); }
const runtime = {}; // name -> { installing, error, step }
const cpuSamples = {};

const NAME_RE = /^avm-[a-f0-9]{8}$/;
const err = (status, msg) => Object.assign(new Error(msg), { status });

// ---------- express ----------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.get('/health', (req, res) => res.json({ ok: true }));

function tokenOk(t) {
  if (!t || typeof t !== 'string') return false;
  const a = Buffer.from(t), b = Buffer.from(cfg.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.use('/api', (req, res, next) => {
  if (!tokenOk((req.headers.authorization || '').replace(/^Bearer /, ''))) return res.status(401).json({ error: 'Invalid node token' });
  next();
});
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 500).json({ error: e.message }));
function vmName(req) {
  const n = req.params.name;
  if (!NAME_RE.test(n) || !S.vms[n]) throw err(404, 'VM not found on this node');
  return n;
}
function cleanPath(p) {
  p = String(p || '/');
  if (p.includes('\0')) throw err(400, 'Bad path');
  return path.posix.normalize('/' + p);
}

// ---------- helpers ----------
async function bridgeSubnet() {
  const cidr = (await incus.run(['network', 'get', BRIDGE, 'ipv4.address'])).trim(); // e.g. 10.55.2.1/24
  const [gw, bits] = cidr.split('/');
  return { gw, bits: +bits, prefix: gw.split('.').slice(0, 3).join('.') };
}
async function allocIp() {
  const { prefix, gw } = await bridgeSubnet();
  const used = new Set(Object.values(S.vms).map((v) => v.privateIp));
  used.add(gw);
  for (let i = 10; i < 250; i++) { const ip = `${prefix}.${i}`; if (!used.has(ip)) return ip; }
  throw err(507, 'No free private IPs left on the bridge');
}
function parseSize(v) {
  if (!v) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]i?B|[KMGT]?B?)?$/i.exec(String(v).trim());
  if (!m) return 0;
  const u = (m[2] || 'B').toUpperCase().replace('IB', 'B');
  return Math.round(+m[1] * ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[u] || 1));
}

// ---------- system ----------
app.get('/api/system', wrap(async (req, res) => {
  let version = null, incusOk = true, subnet = null;
  try { version = (await incus.run(['version'])).trim().split('\n').pop().replace(/.*:\s*/, ''); } catch { incusOk = false; }
  try { subnet = (await incus.run(['network', 'get', BRIDGE, 'ipv4.address'])).trim(); } catch {}
  res.json({
    hostname: os.hostname(), cpus: os.cpus().length, memTotal: os.totalmem(), memFree: os.freemem(), load: os.loadavg(), uptime: os.uptime(),
    incus: incusOk, incusVersion: version, kvm: fs.existsSync('/dev/kvm'), ufw: await net.ufwActive(), bridge: BRIDGE, subnet,
    vms: Object.keys(S.vms).length, ports: S.ports.length, ips: S.ips.length,
  });
}));

// ---------- available OS images (live from the images: remote, cached 1h) ----------
let imgCache = { at: 0, list: null, pending: null };
async function fetchImages() {
  const raw = await incus.json(['image', 'list', 'images:', '--format', 'json']);
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch] || 'x86_64';
  const map = {};
  for (const im of raw) {
    if (im.architecture !== arch) continue;
    const p = im.properties || {};
    if (p.variant && p.variant !== 'default' && p.variant !== 'cloud') continue;
    const names = (im.aliases || []).map((a) => a.name).filter((n) => n.split('/').length === 2);
    if (!names.length) continue;
    // prefer the numeric alias (ubuntu/24.04 over ubuntu/noble)
    names.sort((a, b) => (/\/\d/.test(b) - /\/\d/.test(a)) || a.length - b.length);
    const alias = names[0];
    const [os, version] = alias.split('/');
    const e = map[alias] || (map[alias] = { id: 'images:' + alias, os, name: p.os || os, version, release: p.release || '', container: false, vm: false });
    if (im.type === 'virtual-machine') e.vm = true; else e.container = true;
  }
  // newest numeric version first, rolling names (edge, current, sid…) last
  const num = (v) => /^\d/.test(v);
  return Object.values(map).sort((a, b) => a.os.localeCompare(b.os) || (num(b.version) - num(a.version)) || b.version.localeCompare(a.version, undefined, { numeric: true }));
}
app.get('/api/images', wrap(async (req, res) => {
  if (!imgCache.list || Date.now() - imgCache.at > 3600e3) {
    imgCache.pending = imgCache.pending || fetchImages().finally(() => { imgCache.pending = null; });
    try { imgCache.list = await imgCache.pending; imgCache.at = Date.now(); }
    catch (e) { if (!imgCache.list) throw err(502, 'Could not reach the image server: ' + e.message); }
  }
  res.json(imgCache.list);
}));

// ---------- create ----------
app.post('/api/vms', wrap(async (req, res) => {
  const { name, type, image, cpu, memory, disk } = req.body;
  if (!NAME_RE.test(name || '')) throw err(400, 'bad name');
  if (S.vms[name]) throw err(409, 'VM already exists');
  if (!['container', 'vm'].includes(type)) throw err(400, 'type must be container or vm');
  if (type === 'vm' && !fs.existsSync('/dev/kvm') && !process.env.AVM_FAKE_KVM) throw err(400, 'This node has no /dev/kvm - only LXC containers can be created');
  if (!/^[\w.:/@-]{3,100}$/.test(image || '')) throw err(400, 'bad image');
  const privateIp = await allocIp();
  S.vms[name] = { type, image, cpu: Math.max(1, +cpu || 1), memory: Math.max(128, +memory || 1024), disk: Math.max(1, +disk || 10), privateIp, createdAt: Date.now() };
  save();
  buildVm(name); // background - image download can take minutes
  res.json({ ok: true, privateIp });
}));

async function buildVm(name) {
  const v = S.vms[name];
  runtime[name] = { installing: true, error: null, step: 'Downloading image ' + v.image };
  try {
    const args = ['init', v.image, name, '-c', `limits.cpu=${v.cpu}`, '-c', `limits.memory=${v.memory}MiB`];
    if (v.type === 'vm') args.push('--vm');
    else args.push('-c', 'security.nesting=true');
    try { await incus.run([...args, '-d', `root,size=${v.disk}GiB`], { timeout: 30 * 60000 }); }
    catch (e) {
      // "dir" storage pools without project quotas cannot limit container disk size -> create without the limit
      if (v.type === 'vm' || !/quota|size/i.test(e.message)) throw e;
      console.warn('[avm-node] disk size limit not supported by this storage pool, creating', name, 'without it');
      await incus.run(['delete', name, '--force']).catch(() => {});
      runtime[name].step = 'Downloading image ' + v.image + ' (no disk quota on this pool)';
      await incus.run(args, { timeout: 30 * 60000 });
    }
    runtime[name].step = 'Configuring network';
    try { await incus.run(['config', 'device', 'override', name, 'eth0', `ipv4.address=${v.privateIp}`]); }
    catch { await incus.run(['config', 'device', 'set', name, 'eth0', `ipv4.address=${v.privateIp}`]); }
    runtime[name].step = 'Starting';
    await incus.run(['start', name]);
    runtime[name] = { installing: false, error: null };
    // re-apply any rules that were added while installing
    for (const p of S.ports.filter((x) => x.name === name)) await net.addPort(p).catch(() => {});
  } catch (e) {
    console.error('[avm-node] create failed', name, e.message);
    runtime[name] = { installing: false, error: e.message };
  }
}

// ---------- status / usage ----------
app.get('/api/vms/:name/status', wrap(async (req, res) => {
  const name = vmName(req);
  const v = S.vms[name], rt = runtime[name] || {};
  const out = { state: 'unknown', installing: !!rt.installing, step: rt.step || null, error: rt.error || null, type: v.type, privateIp: v.privateIp,
    cpu: 0, cpus: v.cpu, memory: 0, memLimit: v.memory * 1048576, disk: 0, diskLimit: v.disk * 1073741824, netRx: 0, netTx: 0, processes: 0 };
  if (rt.installing) { out.state = 'installing'; return res.json(out); }
  let st;
  try { st = await incus.query(`/1.0/instances/${name}/state`); }
  catch (e) { out.state = 'missing'; out.error = out.error || e.message; return res.json(out); }
  out.state = String(st.status || 'unknown').toLowerCase();
  out.processes = st.processes || 0;
  if (st.memory) out.memory = st.memory.usage || 0;
  const usage = st.cpu ? st.cpu.usage : 0, now = Date.now();
  const prev = cpuSamples[name];
  if (prev && usage >= prev.usage && out.state === 'running') {
    out.cpu = +(((usage - prev.usage) / ((now - prev.at) * 1e6)) / v.cpu * 100).toFixed(1);
  }
  cpuSamples[name] = { usage, at: now };
  if (st.disk && st.disk.root && st.disk.root.usage) out.disk = st.disk.root.usage;
  else if (out.state === 'running') {
    try { const [used, total] = (await incus.exec(name, "df -B1 / | tail -1 | awk '{print $3, $2}'", [], { timeout: 8000 })).trim().split(/\s+/).map(Number); out.disk = used || 0; if (total && !v.diskExact) out.diskLimit = Math.min(out.diskLimit, total) || out.diskLimit; } catch {}
  }
  const eth = st.network && (st.network.eth0 || Object.values(st.network).find((n) => n.type !== 'loopback'));
  if (eth && eth.counters) { out.netRx = eth.counters.bytes_received || 0; out.netTx = eth.counters.bytes_sent || 0; }
  res.json(out);
}));

// ---------- power ----------
app.post('/api/vms/:name/power', wrap(async (req, res) => {
  const name = vmName(req);
  if (runtime[name] && runtime[name].installing) throw err(409, 'VM is still being created, please wait');
  const a = req.body.action;
  const tryForce = async (cmd) => { try { await incus.run([cmd, name, '--timeout', '30'], { timeout: 60000 }); } catch { await incus.run([cmd, name, '--force'], { timeout: 60000 }); } };
  if (a === 'start') await incus.run(['start', name], { timeout: 120000 }).catch((e) => { if (!/already running/i.test(e.message)) throw e; });
  else if (a === 'stop') await tryForce('stop').catch((e) => { if (!/already stopped|not running/i.test(e.message)) throw e; });
  else if (a === 'restart') await tryForce('restart');
  else if (a === 'kill') await incus.run(['stop', name, '--force']).catch(() => {});
  else throw err(400, 'bad action');
  res.json({ ok: true });
}));

// ---------- delete ----------
app.delete('/api/vms/:name', wrap(async (req, res) => {
  const name = vmName(req);
  for (const p of S.ports.filter((x) => x.name === name)) await net.removePort(p).catch(() => {});
  for (const x of S.ips.filter((i) => i.name === name)) await net.removePublicIp(x, cfg.iface).catch(() => {});
  S.ports = S.ports.filter((x) => x.name !== name);
  S.ips = S.ips.filter((x) => x.name !== name);
  await incus.run(['delete', name, '--force'], { timeout: 120000 }).catch((e) => { if (!/not found/i.test(e.message)) throw e; });
  delete S.vms[name]; delete runtime[name]; save();
  res.json({ ok: true });
}));

// ---------- root password ----------
app.post('/api/vms/:name/password', wrap(async (req, res) => {
  const name = vmName(req);
  const pw = String(req.body.password || '');
  if (pw.length < 6 || /[\n:]/.test(pw)) throw err(400, 'Password must be 6+ characters (no ":" or new lines)');
  await incus.exec(name, 'echo "root:$1" | chpasswd', [pw], { timeout: 20000 });
  res.json({ ok: true });
}));

// ---------- sshx ----------
const SSHX_CMD = 'curl -sSf https://sshx.io/get | sh -s run';
app.post('/api/vms/:name/sshx', wrap(async (req, res) => {
  const name = vmName(req);
  const st = await incus.query(`/1.0/instances/${name}/state`).catch(() => null);
  if (!st || String(st.status).toLowerCase() !== 'running') throw err(409, 'Start the VM first');
  const readLink = async () => {
    const out = await incus.exec(name, 'cat /tmp/avm-sshx.log 2>/dev/null; echo; (pgrep -x sshx >/dev/null && echo AVM_RUNNING) || true', [], { timeout: 10000 }).catch(() => '');
    const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const m = /https:\/\/sshx\.io\/s\/[^\s"']+/.exec(clean);
    return { url: m ? m[0] : null, running: clean.includes('AVM_RUNNING'), log: clean };
  };
  if (!req.body.fresh) { const cur = await readLink(); if (cur.url && cur.running) return res.json({ url: cur.url, reused: true }); }
  const script = `
pkill -x sshx 2>/dev/null; rm -f /tmp/avm-sshx.log
if ! command -v curl >/dev/null 2>&1; then
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates) >/dev/null 2>&1 \
  || apk add --no-cache curl >/dev/null 2>&1 || dnf install -y -q curl >/dev/null 2>&1 || yum install -y -q curl >/dev/null 2>&1 || pacman -Sy --noconfirm curl >/dev/null 2>&1
fi
setsid nohup sh -c '${SSHX_CMD}' >/tmp/avm-sshx.log 2>&1 </dev/null &
echo started`;
  await incus.exec(name, script, [], { timeout: 180000 });
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const cur = await readLink();
    if (cur.url) return res.json({ url: cur.url });
    if (i > 5 && !cur.running && /error|not found|failed/i.test(cur.log)) throw err(502, 'sshx failed: ' + cur.log.trim().slice(-300));
  }
  throw err(504, 'sshx did not return a link in time - check the VM has internet');
}));

// ---------- file manager (inside the VM) ----------
app.get('/api/vms/:name/files', wrap(async (req, res) => {
  const name = vmName(req), dir = cleanPath(req.query.path);
  const script = `d="$1"; [ -d "$d" ] || { echo "AVM_NOTDIR"; exit 0; }
for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; stat -c '%F|%s|%Y|%n' "$f" 2>/dev/null; done`;
  const out = await incus.exec(name, script, [dir], { timeout: 20000 });
  if (out.includes('AVM_NOTDIR')) throw err(400, 'Not a folder');
  const list = out.split('\n').filter(Boolean).map((l) => {
    const [type, size, mtime, ...rest] = l.split('|');
    const full = rest.join('|');
    return { name: full.split('/').pop(), dir: type === 'directory', link: /link/.test(type), size: +size || 0, mtime: (+mtime || 0) * 1000 };
  }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  res.json(list);
}));
app.get('/api/vms/:name/files/content', wrap(async (req, res) => {
  const name = vmName(req), f = cleanPath(req.query.path);
  const size = +(await incus.exec(name, 'stat -c %s "$1"', [f])).trim();
  if (size > 5 * 1048576) throw err(413, 'File too large to edit (5MB max) - download it instead');
  res.json({ content: await incus.exec(name, 'cat "$1"', [f]) });
}));
app.post('/api/vms/:name/files/write', wrap(async (req, res) => {
  const name = vmName(req), f = cleanPath(req.body.path);
  await incus.run(['exec', name, '--', 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', f], { input: String(req.body.content ?? '') });
  res.json({ ok: true });
}));
app.post('/api/vms/:name/files/mkdir', wrap(async (req, res) => {
  const name = vmName(req);
  await incus.exec(name, 'mkdir -p "$1"', [cleanPath(req.body.path)]);
  res.json({ ok: true });
}));
app.post('/api/vms/:name/files/rename', wrap(async (req, res) => {
  const name = vmName(req);
  await incus.exec(name, 'mv "$1" "$2"', [cleanPath(req.body.from), cleanPath(req.body.to)]);
  res.json({ ok: true });
}));
app.post('/api/vms/:name/files/delete', wrap(async (req, res) => {
  const name = vmName(req);
  const paths = (req.body.paths || []).map(cleanPath).filter((p) => p !== '/');
  if (paths.length) await incus.exec(name, 'rm -rf -- "$@"', paths);
  res.json({ ok: true });
}));
const upload = multer({ dest: path.join(os.tmpdir(), 'avm-up'), limits: { fileSize: 2048 * 1048576 } });
app.post('/api/vms/:name/files/upload', upload.array('files'), wrap(async (req, res) => {
  const name = vmName(req), dir = cleanPath(req.query.path);
  try {
    await incus.exec(name, 'mkdir -p "$1"', [dir]);
    for (const f of req.files || []) {
      const target = path.posix.join(dir, path.basename(f.originalname));
      await incus.run(['file', 'push', f.path, `${name}${target}`], { timeout: 600000 });
    }
  } finally { for (const f of req.files || []) fsp.rm(f.path, { force: true }).catch(() => {}); }
  res.json({ ok: true, count: (req.files || []).length });
}));
app.get('/api/vms/:name/files/download', wrap(async (req, res) => {
  const name = vmName(req), f = cleanPath(req.query.path);
  const tmp = path.join(os.tmpdir(), 'avm-dl-' + crypto.randomBytes(6).toString('hex'));
  await incus.run(['file', 'pull', `${name}${f}`, tmp], { timeout: 600000 });
  res.download(tmp, path.posix.basename(f), () => fsp.rm(tmp, { force: true }).catch(() => {}));
}));

// ---------- ports ----------
app.post('/api/vms/:name/ports', wrap(async (req, res) => {
  const name = vmName(req);
  const hostPort = +req.body.hostPort, vmPort = +req.body.vmPort, proto = req.body.proto === 'udp' ? 'udp' : 'tcp';
  if (!(hostPort > 0 && hostPort < 65536 && vmPort > 0 && vmPort < 65536)) throw err(400, 'Bad port');
  if (S.ports.some((p) => p.hostPort === hostPort && p.proto === proto)) throw err(409, 'Host port already used');
  const p = { name, hostPort, vmPort, proto, ip: S.vms[name].privateIp };
  await net.addPort(p);
  S.ports.push(p); save();
  res.json({ ok: true });
}));
app.delete('/api/vms/:name/ports', wrap(async (req, res) => {
  const name = vmName(req);
  const hostPort = +req.body.hostPort, proto = req.body.proto === 'udp' ? 'udp' : 'tcp';
  const p = S.ports.find((x) => x.name === name && x.hostPort === hostPort && x.proto === proto);
  if (p) { await net.removePort(p); S.ports = S.ports.filter((x) => x !== p); save(); }
  res.json({ ok: true });
}));

// ---------- dedicated public IP (1:1 NAT) ----------
app.post('/api/vms/:name/ip', wrap(async (req, res) => {
  const name = vmName(req);
  const pub = String(req.body.ip || '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(pub)) throw err(400, 'Bad IPv4');
  if (S.ips.some((x) => x.pub === pub)) throw err(409, 'IP already assigned');
  for (const x of S.ips.filter((i) => i.name === name)) { await net.removePublicIp(x, cfg.iface); }
  S.ips = S.ips.filter((i) => i.name !== name);
  const x = { name, pub, priv: S.vms[name].privateIp };
  await net.addPublicIp(x, cfg.iface);
  S.ips.push(x); save();
  res.json({ ok: true });
}));
app.delete('/api/vms/:name/ip', wrap(async (req, res) => {
  const name = vmName(req);
  for (const x of S.ips.filter((i) => i.name === name)) await net.removePublicIp(x, cfg.iface);
  S.ips = S.ips.filter((i) => i.name !== name); save();
  res.json({ ok: true });
}));

// ---------- web console (pty -> incus exec) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
let pty = null;
try { pty = require('@homebridge/node-pty-prebuilt-multiarch'); } catch (e) { console.error('[avm-node] node-pty not available:', e.message); }

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const m = /^\/api\/vms\/(avm-[a-f0-9]{8})\/console$/.exec(u.pathname);
  if (!m || !tokenOk(u.searchParams.get('token')) || !S.vms[m[1]]) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onConsole(ws, m[1], +u.searchParams.get('cols') || 100, +u.searchParams.get('rows') || 30));
});

async function onConsole(ws, name, cols, rows) {
  const say = (t) => { if (ws.readyState === 1) ws.send(t); };
  const st = await incus.query(`/1.0/instances/${name}/state`).catch(() => null);
  if (!st || String(st.status).toLowerCase() !== 'running') { say('\r\n\x1b[36m[AVM]\x1b[0m VM is not running. Press Start.\r\n'); return ws.close(); }
  if (!pty) { say('\r\n[AVM] Console unavailable on this node (node-pty missing).\r\n'); return ws.close(); }
  const shell = 'export TERM=xterm-256color; cd ~ 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi';
  const term = pty.spawn(incus.BIN, ['exec', name, '-t', '--', 'sh', '-c', shell], { name: 'xterm-256color', cols, rows, env: { ...process.env, TERM: 'xterm-256color' } });
  term.onData((d) => say(d));
  term.onExit(() => { say('\r\n\x1b[36m[AVM]\x1b[0m session ended\r\n'); try { ws.close(); } catch {} });
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.type === 'input' && typeof d.data === 'string') term.write(d.data);
    else if (d.type === 'resize' && d.cols > 0 && d.rows > 0) { try { term.resize(Math.min(500, d.cols), Math.min(200, d.rows)); } catch {} }
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
}

// ---------- boot: re-apply network rules (iptables is not persistent) ----------
(async () => {
  for (const p of S.ports) await net.addPort(p).catch((e) => console.error('[avm-node] port restore failed', p.hostPort, e.message));
  for (const x of S.ips) await net.addPublicIp(x, cfg.iface).catch((e) => console.error('[avm-node] ip restore failed', x.pub, e.message));
  server.listen(PORT, cfg.host || '127.0.0.1', () => console.log(`[avm-node] listening on ${cfg.host || '127.0.0.1'}:${PORT} (kvm: ${fs.existsSync('/dev/kvm')})`));
})();
