#!/usr/bin/env python3
"""打包可分发产物：读 manifest 版本号 -> 输出 crx 与 SHA-256。

用法：
    python tools/build-release.py

产物写入 build/out/。只分发 crx，不再生成 zip 安装包。
crx 由本机 Chrome 签名，密钥固定为 .keys/manqu.pem
（同一把密钥决定扩展 ID，删掉它会导致后续版本换 ID、用户必须重装）。
"""
import hashlib
import json
import os
import shutil
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
KEY = os.path.join(ROOT, ".keys", "manqu.pem")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# 只有这些是运行时需要的；assets/ 与 tools/ 属于开发素材，不进安装包
RUNTIME = ["manifest.json", "popup.html", "popup.js", "src", "icons"]


def stage(dst):
    for name in RUNTIME:
        src = os.path.join(ROOT, name)
        target = os.path.join(dst, name)
        if os.path.isdir(src):
            shutil.copytree(src, target)
        else:
            shutil.copy2(src, target)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    base = "manqu-v" + version

    # 唯一名暂存目录：本机删除被劫持，固定名会因残留而反复失败
    stage_dir = os.path.join(BUILD, "stage-%d" % time.time())
    os.makedirs(stage_dir)
    stage(stage_dir)

    out = os.path.join(BUILD, "out")
    os.makedirs(out, exist_ok=True)

    args = [CHROME, "--pack-extension=" + stage_dir, "--no-message-box"]
    if os.path.exists(KEY):
        args.append("--pack-extension-key=" + KEY)
    subprocess.run(args, timeout=180, check=False)

    produced = stage_dir + ".crx"
    if not os.path.exists(produced):
        raise SystemExit("Chrome 未产出 crx，打包失败")

    crx_path = os.path.join(out, base + ".crx")
    shutil.move(produced, crx_path)

    pem = stage_dir + ".pem"
    if os.path.exists(pem) and not os.path.exists(KEY):
        os.makedirs(os.path.dirname(KEY), exist_ok=True)
        shutil.move(pem, KEY)

    print("%s\t%d\t%s" % (os.path.basename(crx_path), os.path.getsize(crx_path), sha256(crx_path)))


if __name__ == "__main__":
    main()
