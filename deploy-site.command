#!/bin/bash
# 更新公開網站（GitHub Pages）：重新產生頁面 → 檢查沒有個人資料 → 推到 gh-pages 分支。
#
# 用法：在 Finder 雙擊這個檔案，或在終端機跑
#   ./deploy-site.command            # 用本機已下載的路網資料
#   ./deploy-site.command --refresh  # 先重新下載 LTA 公車資料（需要 .env 的 LTA key）
#
# 頁面一律用 config.py 的中性預設值（City Hall、沒有廠車點），
# 不會帶上你在 app 裡存的 data/processed/setup.json。
#
# 回滾到上一版：
#   git log --oneline gh-pages                       # 找上一版的 commit
#   git push --force github <那個commit>:gh-pages
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="${DEPLOY_REMOTE:-github}"
BRANCH=gh-pages
PAGE=output/site/index.html

echo "▶ 產生網站頁面…"
.venv/bin/python main.py --public "$@"

echo "▶ 檢查頁面沒有帶到個人設定或金鑰…"
.venv/bin/python - "$PAGE" <<'EOF'
import json, re, sys
import config
s = open(sys.argv[1], encoding="utf-8").read()
start = s.index("window.EMBEDDED_BUNDLE = ") + len("window.EMBEDDED_BUNDLE = ")
setup = json.loads(s[start:s.index(";</script>", start)])["setup"]
problems = []
if setup["company"].get("name") != config.COMPANY_NAME:
    problems.append(f"上班地點是 {setup['company'].get('name')!r}，不是預設的 {config.COMPANY_NAME!r}")
if len(setup["shuttles"]) != len(config.SHUTTLE_STOPS):
    problems.append(f"帶了 {len(setup['shuttles'])} 個廠車點（預設是 {len(config.SHUTTLE_STOPS)} 個）")
if re.search(r"AIza[0-9A-Za-z_-]{20,}", s):
    problems.append("頁面裡有 Google API key")
try:
    for line in open(".env", encoding="utf-8"):
        if "=" in line and not line.lstrip().startswith("#"):
            value = line.split("=", 1)[1].strip().strip("'\"")
            if len(value) >= 8 and value in s:
                problems.append(f".env 的 {line.split('=', 1)[0].strip()} 出現在頁面裡")
except FileNotFoundError:
    pass
if problems:
    print("✗ 不部署：\n  " + "\n  ".join(problems), file=sys.stderr)
    sys.exit(1)
print("  ✓ 沒問題")
EOF

echo "▶ 寫入 $BRANCH 分支（不動你目前的工作目錄）…"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE="$tmp/index"
git read-tree --empty
git update-index --add --cacheinfo "100644,$(git hash-object -w "$PAGE"),index.html"
git update-index --add --cacheinfo "100644,$(git hash-object -w /dev/null),.nojekyll"
tree="$(git write-tree)"
unset GIT_INDEX_FILE

parent="$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)"
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "  頁面跟上一版一模一樣，不用新增 commit"
else
  commit="$(git commit-tree "$tree" ${parent:+-p "$parent"} \
    -m "chore: 更新公開網站（$(date +%Y-%m-%d)，來源 $(git rev-parse --short HEAD)）")"
  git update-ref "refs/heads/$BRANCH" "$commit"
  echo "  新版本 $(git rev-parse --short "$commit")"
fi

echo "▶ 推到 $REMOTE…"
git push "$REMOTE" "$BRANCH"

# owner/repo from the remote URL, so a fork deploys to its own address
slug="$(git remote get-url "$REMOTE" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
echo
echo "✓ 完成。GitHub 通常 1 分鐘內更新：https://${slug%%/*}.github.io/${slug#*/}/"
