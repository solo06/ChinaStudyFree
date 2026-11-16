#!/usr/bin/env bash
# 账号 / 管理后台接口冒烟测试
# 用法：先启动 apps/server（DATA_DIR 指向临时目录，ADMIN_EMAIL/PASSWORD 由环境变量给），再跑本脚本
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin-password-123}"
SUFFIX="$(date +%s)"
ALICE="alice-${SUFFIX}@example.com"
BOB="bob-${SUFFIX}@example.com"

pass=0
fail=0

# expect <名称> <期望状态码> <curl 参数...>
expect() {
  local name="$1" want="$2"; shift 2
  local body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' "$@" || echo 000)"
  if [ "$status" = "$want" ]; then
    echo "  ✓ ${name} → ${status}"
    pass=$((pass + 1))
  else
    echo "  ✗ ${name} → ${status}（期望 ${want}）"
    echo "    响应: $(head -c 300 "$body")"
    fail=$((fail + 1))
  fi
  LAST_BODY="$body"
}

json() { printf '%s' "$1"; }

echo "[1] 等待服务就绪"
for _ in $(seq 1 40); do
  if curl -fsS "${BASE}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "${BASE}/api/health" >/dev/null || { echo "服务未启动"; exit 1; }

echo "[2] 注册 / 登录 / 会话"
expect "注册 alice" 201 -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' -d "{\"email\":\"${ALICE}\",\"password\":\"alice-pass-123\",\"name\":\"Alice\"}"
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$LAST_BODY")

expect "重复注册被拒" 409 -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' -d "{\"email\":\"${ALICE}\",\"password\":\"alice-pass-123\"}"
expect "密码错误被拒" 401 -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"${ALICE}\",\"password\":\"wrong-pass-123\"}"
expect "正确登录" 200 -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"${ALICE}\",\"password\":\"alice-pass-123\"}"
expect "带 token 取 me" 200 "${BASE}/api/auth/me" -H "Authorization: Bearer ${TOKEN}"
expect "无 token 取 me 返回 401" 401 "${BASE}/api/auth/me"

echo "[3] 管理员与权限"
expect "管理员登录" 200 -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}"
ADMIN_TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$LAST_BODY")

expect "普通用户访问 admin 被拒" 403 "${BASE}/api/admin/users" -H "Authorization: Bearer ${TOKEN}"
expect "管理员可列用户" 200 "${BASE}/api/admin/users" -H "Authorization: Bearer ${ADMIN_TOKEN}"
grep -q "${ALICE}" "$LAST_BODY" || { echo "  ✗ 用户列表里没有 alice"; fail=$((fail + 1)); }

ALICE_ID=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print([u["id"] for u in d["users"] if u["email"]==sys.argv[2]][0])' "$LAST_BODY" "${ALICE}")

expect "改用户 AI 配额" 200 -X PATCH "${BASE}/api/admin/users/${ALICE_ID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"flags":{"aiDailyQuota":5,"aiEnabled":false}}'
grep -q '"aiDailyQuota":5' "$LAST_BODY" || { echo "  ✗ 配额未生效"; fail=$((fail + 1)); }

echo "[4] 站点设置影响注册"
expect "关闭自助注册" 200 -X PUT "${BASE}/api/admin/settings" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"registrationOpen":false}'
expect "关闭后注册返回 403" 403 -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' -d "{\"email\":\"${BOB}\",\"password\":\"bob-pass-1234\"}"
expect "管理员仍可开号" 201 -X POST "${BASE}/api/admin/users" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" -H 'Content-Type: application/json' \
  -d "{\"email\":\"${BOB}\",\"password\":\"bob-pass-1234\",\"role\":\"user\"}"
expect "重新开启注册" 200 -X PUT "${BASE}/api/admin/settings" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"registrationOpen":true}'

echo "[5] 审计日志"
expect "审计日志可读" 200 "${BASE}/api/admin/audit" -H "Authorization: Bearer ${ADMIN_TOKEN}"
grep -q 'admin.update_user' "$LAST_BODY" || { echo "  ✗ 审计里没有 update_user"; fail=$((fail + 1)); }

echo
echo "通过 ${pass} 项，失败 ${fail} 项"
[ "$fail" -eq 0 ]
