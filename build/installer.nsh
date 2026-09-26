; ---------------------------------------------------------------------------
; DSH Desktop 安装器自定义脚本（electron-builder NSIS include）
;
; 需求对应：
;   1. 安装时多线程展开 Harness 运行时（3.5 万个小文件，单线程写实测要 110 秒）
;   2. 静默安装（热更新）结束后自动重启应用；企业批量部署可用环境变量关掉
;   3. 卸载时先终止应用主进程与 dsh 子进程树，再删除安装目录与快捷方式
;   4. 用户数据目录 %APPDATA%\DSH-Desktop 默认保留，卸载时询问是否删除
; ---------------------------------------------------------------------------

; ── 静默安装后自动重启应用 ──────────────────────────────────────────────────
; electron-builder 模板里判断「装完要不要拉起应用」用的是编译期开关 ${isForceRun}
; （assisted 安装器：`${if} ${isForceRun} ${andIf} ${Silent}` 才启动）。它默认关，
; 所以热更新走 /S 静默安装后应用不会自己回来。这里改成运行期条件：
;   默认 1（静默装完自动重启，热更新用户无感）；
;   环境变量 DSH_DESKTOP_NO_RELAUNCH=1 时为 0（企业批量装机不希望自动弹窗时用）。
; 交互式安装不受影响：它走完成页的「运行应用」勾选项。
;
; 注意两个坑：
;   1) 不能用 customInit 赋值 —— 模板里 `!ifmacrodef customInit` 的插入点早于
;      本文件的引入位置，宏根本不会被插入（会触发 NSIS 6001 告警，而 electron-builder
;      把告警当错误）。customInstall 的插入点可靠，就在模板判断 isForceRun 之前。
;   2) 卸载器的编译（BUILD_UNINSTALLER）里没有 installSection.nsh，变量会「未引用」，
;      同样触发 6001，因此这里整体跳过。
!ifndef BUILD_UNINSTALLER
  Var DshForceRun
  Var DshNoRelaunch
  !ifdef isForceRun
    !undef isForceRun
  !endif
  !define isForceRun "$DshForceRun == 1"
!endif

!macro customInstall
  ; ── 0) 终止运行中的旧实例 ──────────────────────────────────────────────────
  ; 覆盖安装时旧进程可能还在跑：asar 文件虽被替换，但旧进程内存里仍是旧代码
  ; （用户会看到「装了新版还显示旧版本」）；且旧 dsh-runtime 目录被占用会让
  ; 下面的解压静默失败。装机前按镜像名回收整棵进程树（含 dsh 子进程）。
  DetailPrint "正在停止运行中的 DSH Desktop…"
  nsExec::ExecToLog 'taskkill /IM "DSH Desktop.exe" /T /F'
  Pop $0

  ; ── 0b) 清掉旧热壳残留（让新安装版代码生效）────────────────────────────────
  ; 热壳激活规则只校验 baseVersion ≤ 安装版，**不比较热壳与安装版的新旧** ——
  ; 覆盖安装了更高版本的安装包后，用户数据目录里的旧热壳（可能是很久以前的
  ; 热更残留）仍会被优先加载，用户永远停在外壳旧版（2026-09-26 实测踩过：
  ; 装 10.1.0 后仍显示 1.1.24-dev.2，必须手动点「回退版本」才恢复）。
  ; 装机时清空 hot 目录 = 强制回到安装版代码。
  ; 注意：降级热壳（滚回用）是装完之后通过 feed 落位的，不受本清理影响。
  IfFileExists "$APPDATA\DSH-Desktop\hot\*.*" 0 dsh_hot_done
    DetailPrint "清理旧热壳残留…"
    RMDir /r "$APPDATA\DSH-Desktop\hot"
  dsh_hot_done:

  ; ── 0c) 清掉旧运行时目录（防「混合树」）────────────────────────────────────
  ; NSIS 覆盖安装只覆盖同名文件、不删除旧文件：旧 dsh-runtime（可能是其它版本的
  ; 3.5 万个文件）残留在原位，解 tar 后不同名的旧文件全部留下，组成混合树；
  ; 且 node_modules/@deepseek-ai/dsh/package.json 若因占用未被覆盖，运行时版本
  ; 判定就是错的（实测：装 10.1.0 后运行时仍判为 0.1.7-alpha.2）。
  ; 先删后解 = 保证与安装包内 tar 完全一致；删除失败也不阻断（解压器自会补缺）。
  IfFileExists "$INSTDIR\resources\dsh-runtime\*.*" 0 dsh_rt_clean_done
    DetailPrint "清理旧运行时目录…"
    RMDir /r "$INSTDIR\resources\dsh-runtime"
  dsh_rt_clean_done:

  ; 决定本次静默安装结束后是否自动拉起应用（必须在模板判断 isForceRun 之前赋值）
  StrCpy $DshForceRun 1
  ReadEnvStr $DshNoRelaunch "DSH_DESKTOP_NO_RELAUNCH"
  StrCmp $DshNoRelaunch "1" 0 +2
  StrCpy $DshForceRun 0

  ; ── 多线程展开 Harness 运行时 ─────────────────────────────────────────────
  ; 安装包里运行时只以单个 dsh-runtime.tar 分发（把包内文件数从 3.5 万降到数百），
  ; 由 resources/extract-runtime.cmd（Electron 内置 Node 充当解释器）调用多线程解压器：
  ;   * NSIS 单线程逐个写 3.5 万个小文件：实测 110 秒；
  ;   * 多线程解压器把文件清单按字节均分成几十批、N 个 tar 进程并行写，
  ;     解压完逐文件校验、缺失自动重试（旧版静默丢文件的问题一并解决）：实测约 20 秒。
  IfFileExists "$INSTDIR\resources\dsh-runtime.tar" 0 dsh_rt_done
  IfFileExists "$INSTDIR\resources\extract-runtime.cmd" 0 dsh_rt_done

  DetailPrint "正在多线程展开 Harness 运行时（3.5 万个文件）…"
  nsExec::ExecToLog '"$INSTDIR\resources\extract-runtime.cmd"'
  Pop $0
  StrCmp $0 "0" dsh_rt_ok

  ; 展开失败不阻断安装：应用首次启动时会自动重试（同一套解压器）
  DetailPrint "运行时展开未成功（退出码 $0），首次启动时将自动重试，或手动运行 resources\extract-runtime.cmd 修复。"
  Goto dsh_rt_done

  dsh_rt_ok:
    DetailPrint "运行时展开完成。"
  dsh_rt_done:
!macroend

!macro customUnInstall
  ; 1) 终止应用自身（含以 Electron 内置 Node 运行的 dsh 子进程树）
  ;    dsh 子进程的可执行文件就是应用本体，因此按镜像名回收即可覆盖整棵树
  DetailPrint "正在停止 DSH Desktop 及相关服务进程…"
  nsExec::ExecToLog 'taskkill /IM "DSH Desktop.exe" /T /F'
  Pop $0

  ; 2) 询问是否删除用户数据（配置、会话、日志、dsh 数据目录）
  ;    默认保留：卸载后重装可以接着用
  IfFileExists "$APPDATA\DSH-Desktop\*.*" 0 dsh_keep_data
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "是否同时删除用户数据？$\r$\n$\r$\n包含：配置、会话记录、日志（$APPDATA\DSH-Desktop）。$\r$\n选择“否”将保留这些数据，便于日后重装后继续使用。" \
      /SD IDNO IDYES dsh_delete_data IDNO dsh_keep_data

  dsh_delete_data:
    DetailPrint "正在删除用户数据目录…"
    RMDir /r "$APPDATA\DSH-Desktop"
    Goto dsh_keep_data

  dsh_keep_data:
!macroend

!macro customRemoveFiles
  ; 应用文件删除完成后的残余清理（日志轮转文件等由上面的 RMDir /r 覆盖）
!macroend
