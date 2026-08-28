# VPS relay

Phone Control can keep its HTTP/SSE service on `127.0.0.1` while an FRP client creates an
outbound-only encrypted tunnel to a private VPS. The phone uses ordinary HTTPS and does not need
Tailscale or another device-wide VPN.

```text
phone -> HTTPS edge -> VPS loopback FRP port -> encrypted FRP tunnel
      -> workstation 127.0.0.1:8787 -> Phone Control -> Codex
```

The reference deployment under `deploy/vps-relay/` deliberately uses separate process names,
configuration, logs, and ports. It does not modify an existing Nginx instance or SSH reverse
tunnels. The checked deployment reserves:

- `80/tcp` for ACME HTTP-01 only;
- `28443/tcp` for the phone HTTPS endpoint;
- `27070/tcp` for authenticated TLS FRP clients;
- `127.0.0.1:27878` for the FRP proxy upstream, never public.

The example VPS uses a public, six-day Let's Encrypt IP-address certificate. Renewal must run at
least daily; the included loop checks twice a day and reloads only the isolated Nginx instance.

`203.0.113.10` is a documentation-only address. Replace it with the VPS public IP in every copied
template and local command. The reference server root is `/opt/phone-control-relay`; choosing a
different root requires replacing it consistently in the templates.

## VPS preparation

Use a dedicated VPS or dedicated ports on an existing VPS. The reference files never edit the
system Nginx configuration, but the chosen ports must be free. Install Nginx, OpenSSL, Python 3,
virtualenv support, and systemd using the server distribution's package manager. Download a
trusted `frps` release for the VPS architecture and a matching `frpc` release for the workstation.

Create the isolated layout on the VPS:

```bash
sudo install -d -m 0755 \
  /opt/phone-control-relay/{bin,config,logs,nginx/conf,nginx/logs,acme-webroot,certbot}
sudo install -d -m 0700 /opt/phone-control-relay/secrets
openssl rand -hex 32 | sudo tee /opt/phone-control-relay/secrets/frp-token >/dev/null
sudo chmod 0600 /opt/phone-control-relay/secrets/frp-token
```

Copy the server binary and templates from this repository, then replace `203.0.113.10` with the
real public IP:

```bash
sudo install -m 0755 frps /opt/phone-control-relay/bin/frps
sudo install -m 0644 deploy/vps-relay/frps.toml.example \
  /opt/phone-control-relay/config/frps.toml
sudo install -m 0644 deploy/vps-relay/nginx-bootstrap.conf.example \
  /opt/phone-control-relay/nginx/conf/nginx.conf
```

Create the Certbot virtual environment and request the initial certificate while the bootstrap
Nginx configuration is running. Check the current Certbot syntax for public IP certificates before
requesting one; if the CA or client available to you does not issue an IP certificate, use a domain
name and replace `server_name` and certificate paths accordingly.

After the certificate exists, install `nginx.conf.example`, `renew-cert.sh.example`, and the three
systemd unit examples into their indicated locations. Make the renewal script executable, validate
both configurations, and enable the isolated services:

```bash
sudo /opt/phone-control-relay/bin/frps verify -c \
  /opt/phone-control-relay/config/frps.toml
sudo /usr/sbin/nginx -p /opt/phone-control-relay/nginx/ -c conf/nginx.conf -t
sudo systemctl daemon-reload
sudo systemctl enable --now phone-control-relay-frps.service
sudo systemctl enable --now phone-control-relay-edge.service
sudo systemctl enable --now phone-control-relay-cert.service
```

Some FRP releases do not provide the `verify` subcommand; in that case start `frps` in the
foreground once and confirm it accepts the configuration before enabling systemd. Open only
`80/tcp`, `28443/tcp`, and `27070/tcp` in the VPS firewall. Never expose `27878/tcp` publicly.

Copy the same token to a protected file on the workstation. Do not paste it into shell history or
store it in this repository.

## Local commands

Generate the FRP authentication token into a protected file and install a verified `frpc` binary.
Do not pass the token as a command-line flag.

```bash
phone-control relay configure \
  --client /absolute/path/to/frpc \
  --token-file /absolute/path/to/protected-token \
  --server 203.0.113.10 \
  --server-port 27070 \
  --remote-port 27878 \
  --public-url https://203.0.113.10:28443

phone-control relay install
phone-control relay doctor
```

Configuration alone leaves the current Tailscale/public URL unchanged. After every relay doctor
check passes:

```bash
phone-control relay activate
phone-control service restart
```

Rollback restores both the public URL and cookie transport setting that existed before relay
configuration. An active endpoint must be deactivated before it can be reconfigured:

```bash
phone-control relay deactivate
phone-control service restart
```

Uninstalling the relay service keeps its protected configuration and does not uninstall Phone
Control:

```bash
phone-control relay uninstall
```

## Security boundaries

- `frps` accepts only TLS clients with the shared token and permits only the configured loopback
  proxy port.
- Client heartbeats run every 15 seconds, while the server allows 120 seconds before expiring a
  control connection. This avoids false disconnects on delayed links without hiding a dead client.
- The HTTPS edge blocks `/api/internal/`; Hook ingestion remains local-only.
- Inbound forwarded headers are replaced, not trusted.
- Access logs are disabled so pairing codes, device cookies, session IDs, and URLs are not retained
  on the VPS.
- Pairing remains single-use and per-device credentials remain revocable.
- A trusted HTTPS edge terminates TLS on the VPS. Use L4 TLS pass-through later if the VPS must be
  unable to inspect transient plaintext in memory.

## Operational checks

Before every install, confirm all four reserved ports are unused. Test the local health endpoint,
public health endpoint, authenticated page, SSE for at least 25 seconds, tunnel process restart,
edge restart, and rollback to the prior Tailscale URL. Do not replay state-changing requests whose
delivery result is unknown.

The public smoke tests accept `PHONE_CONTROL_TEST_PUBLIC_URL` so a standby relay can be validated
without replacing the saved Tailscale URL:

```bash
PHONE_CONTROL_TEST_PUBLIC_URL=https://203.0.113.10:28443 \
  node scripts/smoke-stream.mjs
```
