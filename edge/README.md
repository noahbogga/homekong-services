# edge

How the services were reached from the internet.

| Path | What it is |
|---|---|
| `cloudflared/` | A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) config: each public hostname is routed to a container, so no ports had to be opened on the home network. |
| `nginx.conf`, `nginx/` | The nginx reverse proxy in front of everything, plus a branded login page. |
| `tls/` | Where the TLS certificate and key go. |
| `ddns-v-wxyz.sh` | A dynamic-DNS script: every few minutes it checks the public IP and updates a Cloudflare DNS record if it changed. |
| `sync-sky-cdn.sh` | Copies image assets to a separate CDN server with rsync. |
| `crontab.txt` | The cron schedule that runs the DNS script. |

## Setup
- `cloudflared/credentials.json` and `config.yml`: your own tunnel and hostnames.
- `tls/`: your certificate and private key.
- `ddns-v-wxyz.sh`: your Cloudflare email, API token, zone ID and record ID.
- `sync-sky-cdn.sh`: your CDN host.
