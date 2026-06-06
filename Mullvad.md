# VPN Notes

This repository intentionally keeps VPN/container troubleshooting notes generic.

Do not commit:

- VPN account identifiers, relay names, tunnel addresses, or provider-specific status output
- local interface dumps, resolver addresses, router addresses, or hostnames
- authentication files, tokens, API keys, WireGuard private keys, or copied config files
- raw request/response bodies from local model or proxy services

For container builds or package installs behind a VPN, use a host-side HTTP/HTTPS proxy bound to the container bridge and pass the proxy through build arguments or environment variables. Keep any machine-specific values in ignored local notes such as `Mullvad.local.md` or another `*.local.md` file.
