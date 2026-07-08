#!/usr/bin/env bash
# workbench 多平台安装引导:选平台(多选)+ 选模型(models.dev)→ 生成各平台 agent/MCP/hooks。
# 交互运行:  bash setup.sh
# 非交互(CI/自测):设环境变量跳过提问 —— WB_NONINTERACTIVE=1 WB_PLATFORMS="claude codex"
#   WB_ENDPOINTS=service,web WB_MODEL='{"codex":"gpt-5.1-codex"}' WB_PROJECT=/path bash setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/cli.ts"
PROJECT="${WB_PROJECT:-$(pwd)}"
ALL="claude codex opencode cursor"

command -v node >/dev/null 2>&1 || { echo "✗ 需要 node(未找到)"; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "✗ 需要 npx(未找到)"; exit 1; }

# ask "提示" "默认" —— 非交互模式直接返回默认
ask() {
  local ans=""
  if [ -n "${WB_NONINTERACTIVE:-}" ]; then echo "$2"; return; fi
  read -r -p "$1" ans </dev/tty 2>/dev/null || ans=""
  echo "${ans:-$2}"
}

echo "═══ workbench 多平台安装引导 ═══"
echo "  目标项目: $PROJECT"
echo ""

# 1) 平台(空格或逗号分隔多选)
if [ -n "${WB_PLATFORMS:-}" ]; then
  PLATS="$WB_PLATFORMS"
else
  echo "① 目标平台(空格分隔多选;可选: $ALL)"
  PLATS=$(ask "   > [claude] " "claude")
fi
PLATS=$(echo "$PLATS" | tr ',' ' ')
CSV=$(echo "$PLATS" | tr -s ' ' ',' | sed 's/^,//;s/,$//')
for p in $PLATS; do
  case " $ALL " in *" $p "*) ;; *) echo "✗ 未知平台: $p(可选: $ALL)"; exit 1 ;; esac
done

# 2) 端
if [ -n "${WB_ENDPOINTS:-}" ]; then
  ENDPOINTS="$WB_ENDPOINTS"
else
  echo ""
  ENDPOINTS=$(ask "② 端(逗号分隔)[service,web]: " "service,web")
fi

# 3) 模型(models.dev,node 解析,无需 jq)
MODEL_ARG=""
if [ -n "${WB_MODEL:-}" ]; then
  MODEL_ARG="--model=$WB_MODEL"
elif [ -z "${WB_NONINTERACTIVE:-}" ]; then
  echo ""
  echo "③ 模型(从 models.dev 拉取支持 tool_call 的清单;回车用各平台默认)"
  MODELS=$(curl -s https://models.dev/api.json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
      const j=JSON.parse(s),o=[];
      for(const[p,v]of Object.entries(j))for(const[m,mv]of Object.entries(v.models||{}))if(mv.tool_call)o.push(p+"/"+m);
      console.log([...new Set(o)].sort().join("\n"))
    }catch(e){}})' || true)
  if [ -n "$MODELS" ]; then
    echo "$MODELS" | grep -Ei 'anthropic|openai|google|xai|qwen' | head -30 | nl || echo "$MODELS" | head -30 | nl
    echo "   (以上供参考;每个平台可粘贴一个模型串,回车=该平台默认)"
  else
    echo "   (models.dev 不可用,改用各平台默认模型)"
  fi
  JSON="{"; ANY=0
  for p in $PLATS; do
    m=$(ask "   $p 模型(回车=默认): " "")
    if [ -n "$m" ]; then JSON="$JSON\"$p\":\"$m\","; ANY=1; fi
  done
  [ "$ANY" = "1" ] && MODEL_ARG="--model=${JSON%,}}"
fi

# 4) 组装并执行
ARGS=(init "--platforms=$CSV" "--endpoints=$ENDPOINTS" "--project=$PROJECT")
[ -n "$MODEL_ARG" ] && ARGS+=("$MODEL_ARG")

echo ""
echo "▶ npx tsx cli.ts ${ARGS[*]}"
echo ""
npx tsx "$CLI" "${ARGS[@]}"
