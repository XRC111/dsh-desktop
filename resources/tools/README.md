# 内置命令行工具

随外壳分发的 git / python，供模型侧 shell 调用。外壳启动 dsh 时把它们的 bin 目录注入 PATH。
原本 Windows 上 git 常常不在 PATH，模型执行 git 状态查询会直接 not recognized。

## 内容

- `git/`    PortableGit 的**裁剪副本**（只留核心约 24 个文件）。完整 PortableGit 约 130MB；
            剔除 Git Credential Manager 的 GUI 依赖（SkiaSharp / Avalonia / HarfBuzz 等
            约 17MB）与用不到的可执行文件后约 26MB。
            实测可完成 init / commit / log / status / branch / clone。
- `python/` 官方 Python embeddable（约 10MB，含标准库，**不含 pip**）。
            本机那种完整安装是 1261MB（Lib/ 占 1169MB），不可能内置。

## 重新生成

```
node scripts/prepare-tools.mjs --force
```

git 源目录可用 `DSH_PORTABLE_GIT` 指定；python 版本用 `DSH_PYTHON_VERSION`。

## 许可

- git：GPL-2.0（Git for Windows / PortableGit）
- python：PSF License

两者均按其原始许可随附分发；完整许可文本见各自上游发行包。
