#!/bin/bash
CF_EMAIL="CHANGE_ME"
CF_KEY="CHANGE_ME"
ZONE_ID="CHANGE_ME"
RECORD_ID="CHANGE_ME"
RECORD_NAME="CHANGE_ME"

CURRENT_IP=$(curl -s https://api.ipify.org || curl -s https://ifconfig.me)
[ -z "$CURRENT_IP" ] && exit 1

DNS_IP=$(curl -s -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_KEY"   "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" |   python3 -c "import sys,json;print(json.load(sys.stdin)['result']['content'])" 2>/dev/null)

if [ "$CURRENT_IP" != "$DNS_IP" ]; then
  curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID"     -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_KEY"     -H "Content-Type: application/json"     --data "{\"type\":\"A\",\"name\":\"$RECORD_NAME\",\"content\":\"$CURRENT_IP\",\"ttl\":60,\"proxied\":false}" > /dev/null
  echo "$(date): Updated $RECORD_NAME $DNS_IP -> $CURRENT_IP"
fi
