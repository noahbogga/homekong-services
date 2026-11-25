#!/bin/bash
# Sync sky-assets from local filebrowser to VPS CDN
rsync -avz --delete -e "ssh -i ~/.ssh/id_rsa" \
  /home/dockeradmin/services/filebrowser/data/Media/sky-assets/ \
  root@YOUR_CDN_HOST:/var/www/cdn-homekong/sky/
echo "[$(date)] Sky CDN sync complete"
