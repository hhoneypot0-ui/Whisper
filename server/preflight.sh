#!/usr/bin/env bash
# ============================================================
# VPS 部署前体检
# 用法（在 VPS 上，root）：bash preflight.sh
# 作用：把所有"装完才发现不行"的情况提前查出来
# ============================================================
export LC_ALL=C
PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { WARN=$((WARN+1)); printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
sec()  { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

# 体检可能在装 curl 之前跑，所以 HTTP 工具要三级兜底
http_code() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -4 -s -o /dev/null -w '%{http_code}' --max-time 6 "$url" 2>/dev/null || echo 000
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null -T 6 "$url" 2>/dev/null && echo 200 || echo 000
  else
    echo "nohttp"
  fi
}
public_ip() {
  if command -v curl >/dev/null 2>&1; then
    curl -4 -fsSL --max-time 6 https://api.ipify.org 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- -T 6 https://api.ipify.org 2>/dev/null
  fi
}

sec "1. 身份与系统"
[[ $EUID -eq 0 ]] && ok "以 root 运行" || bad "不是 root，后面装包会失败（用 sudo -i 切到 root）"
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  echo "  系统: $PRETTY_NAME"
  case "$ID" in
    ubuntu|debian) ok "系统类型受支持 ($ID)" ;;
    *) warn "非 Debian 系（$ID），脚本里的 apt 命令要改" ;;
  esac
else
  bad "读不到 /etc/os-release"
fi
echo "  内核: $(uname -r)"
echo "  架构: $(uname -m)"
case "$(uname -m)" in
  x86_64|aarch64) ok "架构受支持" ;;
  *) bad "架构 $(uname -m) 没有官方 Node 二进制" ;;
esac

sec "2. 硬件资源"
MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
echo "  内存: ${MEM_MB}MB"
if   [[ $MEM_MB -ge 1800 ]]; then ok "内存充足"
elif [[ $MEM_MB -ge 900  ]]; then ok "内存够用（1G 级别，IM 撑几百用户没问题）"
else warn "内存小于 900MB，建议加 swap"; fi

DISK_FREE=$(df -Pm / | awk 'NR==2{print $4}')
echo "  根分区可用: ${DISK_FREE}MB"
[[ $DISK_FREE -ge 3000 ]] && ok "磁盘充足" || warn "磁盘可用不足 3G，装 Node 会比较紧"

SWAP=$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo)
echo "  Swap: ${SWAP}MB"
[[ $SWAP -gt 0 || $MEM_MB -ge 1800 ]] && ok "内存兜底没问题" || warn "无 swap 且内存偏小，建议 fallocate 建 1G swap"

sec "3. 网络与公网地址"
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  warn "系统里既没有 curl 也没有 wget，跳过网络检测（deploy.sh 会先装上 curl）"
fi
PRIV=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | head -1)
echo "  网卡地址: ${PRIV:-未知}"
IP=$(public_ip)
if [[ -n "$IP" ]]; then
  ok "出口公网 IP: $IP"
  # 判断是不是 NAT 共享 IP（地址和网卡不一致 = 后面有 NAT）
  IFACE_IP="${PRIV%%/*}"
  if [[ -n "$IFACE_IP" && "$IFACE_IP" != "$IP" ]]; then
    warn "网卡地址($IFACE_IP) ≠ 出口IP($IP) → 这台是 NAT 共享 IP"
    warn "  这种机器对外开 80/443 需要在面板做端口转发，HTTPS 证书会签不出来"
  else
    ok "直连公网 IP（KVM 独立 IP），80/443 可以直接用"
  fi
elif command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
  warn "拿不到出口公网 IP，可能被网络限制"
fi

# 到常见源的连通性（部署要下载 Node）
for host in nodejs.org github.com deb.debian.org; do
  code=$(http_code "https://$host")
  case "$code" in
    nohttp) break ;;
    200|301|302|403|404) ok "可访问 $host" ;;
    *) warn "访问 $host 异常（HTTP $code）—— 可能需要换 Node 下载源" ;;
  esac
done

# 日本/香港到国内的延迟参考（只测一个目标）
for target in 223.5.5.5 119.29.29.29; do
  if command -v ping >/dev/null 2>&1; then
    rtt=$(ping -c 2 -W 2 "$target" 2>/dev/null | awk -F'time=' '/time=/{print $2}' | cut -d' ' -f1 | tail -1)
    [[ -n "$rtt" ]] && echo "  到 $target 的 RTT: ${rtt}ms"
  fi
done
[[ $WARN -gt 0 ]] && echo "  （RTT 80ms 以内对 IM 文字聊天完全无感）"

sec "4. 端口可用性"
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&- 3>&-; return 0; } || return 1; }
for p in 80 443; do
  if port_busy $p; then
    who=$(ss -lptnH "sport = :$p" 2>/dev/null | awk '{print $6}' | head -1)
    warn "端口 $p 已被占用 ${who:+($who)} —— 如果占用者是 nginx/apache，部署脚本会冲突"
  else
    ok "端口 $p 空闲"
  fi
done

sec "5. Node.js 与 node:sqlite"
if command -v node >/dev/null 2>&1; then
  NT=$(node -v)
  NMAJ=${NT#v}; NMAJ=${NMAJ%%.*}
  echo "  已装 Node: $NT"
  if node -e "require('node:sqlite')" 2>/dev/null; then
    ok "node:sqlite 可用 → 不需要装原生模块"
  else
    if [[ "$NMAJ" -ge 22 ]]; then
      warn "Node 版本够但 node:sqlite 不可用（可能是裁剪版），部署脚本会重装官方版"
    else
      warn "Node $NT 太旧，node:sqlite 不存在（需要 >=22.5），部署脚本会装 24"
    fi
  fi
else
  warn "还没装 Node（正常，部署脚本会装 24）"
fi

sec "6. 现有 Web 服务（会影响 80/443）"
for s in nginx apache2 httpd caddy; do
  if command -v $s >/dev/null 2>&1; then
    state=$(systemctl is-active $s 2>/dev/null || echo unknown)
    echo "  $s: $state"
    [[ "$state" == "active" ]] && warn "$s 正在运行，会占用 80/443，部署前先停掉或改用它的反代配置"
  fi
done
[[ $WARN -eq 0 ]] || true

sec "7. 时间与时区"
echo "  当前时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
if command -v timedatectl >/dev/null 2>&1 && timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
  ok "NTP 已同步（TLS 证书验证依赖系统时间）"
else
  warn "NTP 未同步，时间偏差会导致 HTTPS 证书验证失败，建议 systemctl enable --now systemd-timesyncd"
fi

sec "8. 防火墙"
if command -v ufw >/dev/null 2>&1; then
  echo "  ufw: $(ufw status 2>/dev/null | head -1)"
  ufw status 2>/dev/null | grep -q "Status: active" && warn "ufw 已启用，稍后需要放行 80/443（部署脚本会做）"
else
  echo "  ufw: 未安装"
fi
if command -v iptables >/dev/null 2>&1; then
  n=$(iptables -S 2>/dev/null | wc -l)
  echo "  iptables 规则数: $n"
fi
echo "  ⚠ 云厂商安全组管不了，需要你到控制台手动放行 80/443"

sec "结论"
printf '  \033[32m通过 %d\033[0m / \033[33m警告 %d\033[0m / \033[31m失败 %d\033[0m\n' "$PASS" "$WARN" "$FAIL"
echo
if [[ $FAIL -gt 0 ]]; then
  echo "  有失败项，先修掉再部署。"
elif [[ $WARN -gt 0 ]]; then
  echo "  有警告项，多数不影响部署，但部署时留意对应提示。"
else
  echo "  全部通过，可以直接部署：bash deploy.sh 你的域名"
fi
echo