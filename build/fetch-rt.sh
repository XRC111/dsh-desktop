#!/usr/bin/env bash
# 一次性：把 dsh 的 next / alpha 两条线各拉一份运行时树到 build/（不动 resources/dsh-runtime 的 rc.3）
# beta 通道 → next（0.1.7-rc.2）；dev 通道 → alpha（0.1.7-alpha.2）
set -e
cd /d/code/dsh-desktop

fetch() {
  local name="$1" ver="$2"
  local dir="build/rt-$name"
  mkdir -p "$dir"
  python -c "
import json
json.dump({'name':'rt-$name','version':'0.0.0','private':True,
           'dependencies':{'@deepseek-ai/dsh':'$ver'}}, open('$dir/package.json','w'), indent=2)
"
  echo "[fetch-rt] 安装 $ver → $dir"
  (
    cd "$dir" &&
      env -u NODE_OPTIONS \
        ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
        npm install --omit=dev --ignore-scripts --no-audit --no-fund \
          --loglevel=error --maxsockets=25 --registry=https://registry.npmmirror.com
  )
  python -c "
import json
p=json.load(open(r'$dir/node_modules/@deepseek-ai/dsh/package.json',encoding='utf8'))
print('[fetch-rt] 完成 $name', p['version'])
"
}

fetch next 0.1.7-rc.2
fetch alpha 0.1.7-alpha.2
echo "[fetch-rt] 全部完成"
