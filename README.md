# ❄ AVM Panel — LXC & KVM Virtual Machine Panel

Glacier-blue panel for running **LXC containers** and **KVM virtual machines** with [Incus](https://linuxcontainers.org/incus/).

> Needs a **dedicated server or a KVM VPS**. Docker / LXC / OpenVZ containers are not supported (they cannot run VMs).
> No `/dev/kvm`? AVM still works with **LXC containers only**.

## Install
1. Push these files to the root of your GitHub repo (`install.sh`, `panel/`, `node/`, `README.md`, `.gitignore`).
2. Set `REPO_URL` at the top of `install.sh` to your repo.
3. On the server (Debian 12/13 or Ubuntu 22.04/24.04, as root):
   ```bash
   git clone https://github.com/<you>/<repo>.git && cd <repo>
   sudo bash install.sh
   ```
The installer checks the host, installs Incus (LXC + KVM), Node.js and pm2, sets up the **local node**, then starts **node daemon → panel** one by one. Choose **1) Public IP** or **2) Cloudflare Tunnel**.

## Features
**Users** — machine list · per-machine sidebar: **Console** (web terminal), **File manager**, **Ports** (expose with ufw), **System usage** (CPU / RAM / disk / network of the VM itself) and **Settings** (root password) · top bar **Start / Stop / Restart / sshx**.
**sshx** — runs `curl -sSf https://sshx.io/get | sh -s run` inside the VM and shows the share link.
**Admin area** — Overview · **Nodes** (local + remote, IP pool) · **Create VM** (owner, node, LXC/KVM, OS, CPU/RAM/disk, dedicated IP) · **Virtual machines** (owner, suspend, delete, manage anyone's VM) · **Ports** (every forward, owner, VM, ufw) · **User management** · **Settings** (panel name, logo, background image/video, sign-up, GitHub & Discord login).

## Networking
- **NAT (default):** each VM gets a private IP on `incusbr0`. Ports are forwarded from the node IP (range 20000-30000, configurable per node) with iptables + ufw.
- **Dedicated IP:** add extra IPv4s to a node's IP pool (Nodes → Edit). Assign one to a VM at creation or later (1:1 NAT).

## GitHub / Discord login
Admin → Settings: paste Client ID + Secret, copy the shown **callback URL** into the GitHub OAuth app / Discord application (OAuth2 → Redirects), then switch it on.

## Docker (experimental)
Runs Incus + node + panel in one **privileged** container. Only on a server where you control Docker (not Railway / shared container hosts).
```bash
git clone https://github.com/adityazdomainzz-code/AVM.git && cd AVM
docker compose -f docker/docker-compose.yml up -d --build
docker logs -f avm          # shows the admin password on first start
```
Uses host networking (panel on `8000`, VM ports `20000-30000`). Data lives in the `avm-data` and `avm-incus` volumes.

## Extra host
`sudo bash install.sh --node-only` on the new server → copy the printed URL + token into Admin → Nodes → Add node.

## Commands
```bash
pm2 logs avm-panel | pm2 logs avm-node
pm2 restart avm-panel avm-node
cd /opt/avm/panel && node src/cli.js admin NewPass123 && pm2 restart avm-panel   # reset admin
```
Ports: panel `8000`, node daemon `8090` (local only), VM forwards `20000-30000`.
