# -*- coding: utf-8 -*-
"""
patch-w7-electron.py — 让 dsh 0.1.7 能跑在 Win7 社区 fork Electron（e3kskoy7wqk/Electron-for-windows-7）上。

背景（2026-09-26 实测结论）：
  dsh 0.1.7 起启动时经 node-addon-require-builtin（NAPI 原生 addon）按宿主指纹白名单校验，
  白名单 = {electron 43.0.0 / 44.0.0 / 45.0.0-alpha.6}，判定依据是
    1) napi_get_node_version 返回的 {major, minor, patch} 数字（编译期烧在宿主 exe 的静态 struct 里）
    2) V8::GetVersion() 返回的版本串（含 "-electron.0" 标记）
  addon 内部的白名单字符串（15.2.124.13-electron.0 等）只是展示/提示，改它们无效（实测）；
  但宿主侧数据永远是运行时读取 → **改宿主 exe 的指纹数据即可过门**。

  w7 fork v44.2.0 真实指纹 = (Node 24.20.0, V8 15.2.124.19-electron.0)，
  官方 44.0.0 指纹    = (Node 24.18.1, V8 15.2.124.13-electron.0)。
  本脚本把宿主指纹统一改成官方 44.0.0 的值 → addon 指纹门放行 →
  后续结构探测（符号解析 / prologue / vtable 扫描）在 15.2.124 分支内全部自适应通过（实测 dsh 完整启动）。

补丁内容（全部等长原位替换，不改文件大小）：
  A. 4 处 "15.2.124.19-electron.0" → "15.2.124.13-electron.0"（V8 版本串）
  B. napi_get_node_version 静态 struct {24,20,0} → {24,18,1}（2 字节）
  C. 其余所有 "24.20.0" → "24.18.1"（独立版本串 / v 前缀串 / nodejs.org URL，纯展示与元数据）

用法：
  python scripts/patch-w7-electron.py [electron.exe 路径]
  缺省路径 build/electron-win7/electron.exe；幂等，已打过补丁则直接成功返回。
"""
import struct
import sys
import os

EXPECTED = {
    "v8_old": b"15.2.124.19-electron.0",
    "v8_new": b"15.2.124.13-electron.0",
    "node_old": b"24.20.0",
    "node_new": b"24.18.1",
}


def sections(data):
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b"PE\x00\x00":
        raise SystemExit("不是 PE 文件")
    coff = e_lfanew + 4
    nsec = struct.unpack_from("<H", data, coff + 2)[0]
    optsize = struct.unpack_from("<H", data, coff + 16)[0]
    opt = coff + 20
    magic = struct.unpack_from("<H", data, opt)[0]
    base = struct.unpack_from("<Q", data, opt + 24)[0] if magic == 0x20B else struct.unpack_from("<I", data, opt + 28)[0]
    tab = opt + optsize
    out = []
    for i in range(nsec):
        off = tab + i * 40
        vsize, vaddr, rsize, raddr = struct.unpack_from("<IIII", data, off + 8)
        out.append((vaddr, vsize, raddr, rsize))
    return base, out


def va2off(base, secs, va):
    rva = va - base
    for vaddr, vsize, raddr, rsize in secs:
        if vaddr <= rva < vaddr + max(vsize, rsize):
            return raddr + (rva - vaddr)
    return None


def find_napi_struct(data, base, secs):
    """napi_get_node_version 导出的静态 struct {major,minor,patch,pad,release_ptr}，
    从导出函数的 lea 指令动态定位（不硬编码偏移，fork 更新后依然可用）。"""
    # PE32+ DataDirectory[0]（Export）在 optional header +112
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    coff = e_lfanew + 4
    opt = coff + 20
    exp_rva = struct.unpack_from("<I", data, opt + 112)[0]
    eo = va2off(base, secs, base + exp_rva)
    if eo is None:
        raise SystemExit("找不到导出表")
    nfuncs, nnames = struct.unpack_from("<II", data, eo + 20)
    aof = struct.unpack_from("<I", data, eo + 28)[0]
    aon = struct.unpack_from("<I", data, eo + 32)[0]
    aoo = struct.unpack_from("<I", data, eo + 36)[0]
    names_off = va2off(base, secs, base + aon)
    for i in range(nnames):
        nrva = struct.unpack_from("<I", data, names_off + i * 4)[0]
        no = va2off(base, secs, base + nrva)
        end = data.index(b"\x00", no)
        if bytes(data[no:end]) != b"napi_get_node_version":
            continue
        ord_idx = struct.unpack_from("<H", data, va2off(base, secs, base + aoo) + i * 2)[0]
        func_rva = struct.unpack_from("<I", data, va2off(base, secs, base + aof) + ord_idx * 4)[0]
        fo = va2off(base, secs, base + func_rva)
        # 函数体形如: b8 01 00 00 00 48 85 c9 74 .. 48 85 d2 74 .. 48 8d 05 <disp32> ...
        code = bytes(data[fo:fo + 48])
        k = code.find(b"\x48\x8d\x05")
        if k < 0:
            raise SystemExit("napi_get_node_version 里没找到 lea（fork 结构变了，需人工复查）")
        rip = func_rva + k + 7
        disp = struct.unpack_from("<i", data, fo + k + 3)[0]
        struct_rva = rip + disp
        so = va2off(base, secs, base + struct_rva)
        return so
    raise SystemExit("导出表里没有 napi_get_node_version")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "electron-win7", "electron.exe")
    data = bytearray(open(path, "rb").read())
    print(f"目标: {path} ({len(data):,} bytes)")

    base, secs = sections(data)
    so = find_napi_struct(data, base, secs)
    nums = struct.unpack_from("<III", data, so)
    print(f"napi_node_version struct @ file {so}: {nums}")

    already = nums == (24, 18, 1) and EXPECTED["v8_old"] not in data and EXPECTED["node_old"] not in data
    if already:
        print("已打过补丁，无需重复处理。")
        return

    # A. V8 版本串（4 处）
    n_v8 = data.count(EXPECTED["v8_old"])
    print(f"A. V8 版本串 {EXPECTED['v8_old'].decode()} x{n_v8}")
    if n_v8 == 0 and EXPECTED["v8_new"] not in data:
        raise SystemExit("既没有 44.2.0 的 V8 串也没有 44.0.0 的，exe 可能不是预期版本")
    data = bytearray(data.replace(EXPECTED["v8_old"], EXPECTED["v8_new"]))

    # B. napi struct 数字 {24,20,0} → {24,18,1}
    if nums == (24, 20, 0):
        data[so + 4] = 18  # minor 20 → 18
        data[so + 8] = 1   # patch 0 → 1
        print("B. napi struct (24,20,0) → (24,18,1)")
    elif nums != (24, 18, 1):
        raise SystemExit(f"napi struct 是 {nums}，不是 (24,20,0)/(24,18,1)，需人工复查")

    # C. 其余 Node 版本串（URL / v 前缀 / 独立串）
    n_node = data.count(EXPECTED["node_old"])
    print(f"C. Node 版本串 {EXPECTED['node_old'].decode()} x{n_node}")
    data = bytearray(data.replace(EXPECTED["node_old"], EXPECTED["node_new"]))

    open(path, "wb").write(data)

    # 复验
    chk = open(path, "rb").read()
    assert chk.count(EXPECTED["v8_old"]) == 0 and chk.count(EXPECTED["node_old"]) == 0
    assert struct.unpack_from("<III", chk, so) == (24, 18, 1)
    print(f"完成：文件 {len(chk):,} bytes（大小不变），宿主现在对外为 "
          f"(Node 24.18.1, V8 15.2.124.13-electron.0, Electron 版本号不变)。")


if __name__ == "__main__":
    main()
