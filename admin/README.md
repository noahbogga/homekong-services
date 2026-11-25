# admin

Tools for running and managing the servers.

| Path | What it is |
|---|---|
| `tx-gate/` | A login gate in front of the admin panels. Passwords are bcrypt-hashed, sessions use JWT, and two-factor auth (TOTP) is supported. Once logged in it shows server status and can restart services over SSH; virtual-machine control is handed off to a small helper on the host machine. |
| `txadmin-proxy/` | Branded pages (login, splash, services, settings) placed in front of FiveM's txAdmin panel. |
| `guacamole/` | [Apache Guacamole](https://guacamole.apache.org/) for remote desktop in the browser, with **mgmt-gate**: its own login + 2FA screen and a dashboard listing the machines. |
| `mgmt-gate-dashboard/` | A standalone copy of that dashboard page. |
| `rustdesk/` | Config for a self-hosted [RustDesk](https://rustdesk.com/) relay server. |
| `ssh-keys/` | Where the SSH key the services use to reach other servers goes. |

## Setup
- `ssh-keys/id` and `tx-gate/ssh_key`: an SSH private key you generate (placeholder files now).
- `tx-gate/jwt_secret`, `tx-gate/vm_secret`: long random strings, e.g. `openssl rand -hex 32`.
- `tx-gate/users.json`: one placeholder admin. Put a bcrypt hash in `hash`; 2FA is off until you set it up.
- `guacamole/docker-compose.yml`: the database passwords (`CHANGE_ME`); `guacamole/certs/`: your TLS certificate.
- `rustdesk/data/`: RustDesk creates its own keys on first start; delete the placeholders.
