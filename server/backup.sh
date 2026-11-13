#!/bin/bash
# 悄悄 · 每日备份：数据库 + 所有图片
# 保留最近 7 份，超出的自动删除

set -e
DATA_DIR="/var/lib/im-server"
BACKUP_DIR="/var/backups/im-server"
KEEP=7
STAMP=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)

mkdir -p "$BACKUP_DIR"

# ① 数据库：先做 WAL checkpoint，保证落的文件是一致的
if [ -f "$DATA_DIR/data.db" ]; then
  cp "$DATA_DIR/data.db" "$TMP/data.db"
  [ -f "$DATA_DIR/data.db-wal" ] && cp "$DATA_DIR/data.db-wal" "$TMP/data.db-wal"
  [ -f "$DATA_DIR/data.db-shm" ] && cp "$DATA_DIR/data.db-shm" "$TMP/data.db-shm"
fi

# ② 图片：整个目录
if [ -d "$DATA_DIR/images" ]; then
  cp -r "$DATA_DIR/images" "$TMP/images"
fi

# ③ 打成一个包
tar -czf "$BACKUP_DIR/backup-$STAMP.tar.gz" -C "$TMP" . 2>/dev/null
rm -rf "$TMP"

# ④ 只留最近 KEEP 份
cd "$BACKUP_DIR"
ls -1t backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

SIZE=$(du -h "$BACKUP_DIR/backup-$STAMP.tar.gz" | cut -f1)
COUNT=$(ls -1 backup-*.tar.gz 2>/dev/null | wc -l)
echo "$(date "+%F %T") 备份完成: backup-$STAMP.tar.gz ($SIZE) | 当前共 $COUNT 份"
