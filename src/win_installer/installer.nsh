!ifndef LOGICLIB
  !ifmacrodef _==_
  !else
    !include "LogicLib.nsh"
  !endif
!endif

!ifndef NSDIALOGS_INCLUDED
  !ifndef NSD_CreateLabel
    !ifmacrodef NSD_CreateControlMacro
    !else
      !include "nsDialogs.nsh"
    !endif
  !endif
!endif

!define ESPRIN_DATA_PATH_FILE "$APPDATA\esprin_nemo\data_path.json"

!ifndef BUILD_UNINSTALLER
  Var EsprinDataDirCheckBox
  Var EsprinDataDirPathEdit
  Var EsprinDataDirMode
  Var EsprinDataDirPath
  # 应用内自动更新：安装包被以 --upgrade 启动时为 "1"（见下方 customInit）
  Var EsprinUpgradeMode
!endif

/* 应用内更新（--upgrade）：应用会把新版本的安装包下载到临时目录，然后以命令行运行它：
     "Esprin Nemo Setup x.y.z.exe" --upgrade --updated --force-run
   --upgrade 由本文件识别（跳过数据位置向导页、沿用上次的安装范围、不显示“完成”页，
   安装结束后自动重新拉起应用），--updated / --force-run 是 electron-builder 自带的开关，
   用于跳过许可与安装目录向导页、并且允许安装程序等待旧进程退出。
   最终用户能看到的只有一个安装进度页（进度条 + “正在更新”标题）。
   手工双击安装包时不带这些参数，因此仍然走完整的向导流程。 */

!macro customInit
  !ifndef BUILD_UNINSTALLER
    ${StdUtils.TestParameter} $R9 "upgrade"
    ${If} $R9 != "true"
      # 兜底：只带了 electron-builder 的升级开关时同样按升级处理
      # （例如 UAC 提权后重新启动的内层实例）
      ${StdUtils.TestParameter} $R9 "updated"
    ${EndIf}
    ${If} $R9 == "true"
      StrCpy $EsprinUpgradeMode "1"
    ${EndIf}
  !endif
!macroend

/* 安装范围：升级时沿用上次装好的范围（仅当前用户 / 本机所有用户），
   这样安装向导的“为谁安装”选择页会被直接跳过；普通安装不受影响，仍由用户选择。
   electron-builder 在同一处分别用了 customInstallmode（检查）与 customInstallMode（插入）
   两种拼写，这里把两种拼写都补上：先定义的那个会被后面的 !ifmacrodef 命中并跳过，
   因此无论 NSIS 的符号是否区分大小写都不会重复定义、也不会漏掉。 */
!macro EsprinApplyInstallModeOnUpgrade
  !ifndef BUILD_UNINSTALLER
    ${If} $EsprinUpgradeMode == "1"
      ${If} $hasPerMachineInstallation == "1"
        StrCpy $isForceMachineInstall "1"
      ${Else}
        StrCpy $isForceCurrentInstall "1"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!ifmacrodef customInstallMode
!else
  !macro customInstallMode
    !insertmacro EsprinApplyInstallModeOnUpgrade
  !macroend
!endif

!ifmacrodef customInstallmode
!else
  !macro customInstallmode
    !insertmacro EsprinApplyInstallModeOnUpgrade
  !macroend
!endif

/* 升级时不显示“完成”页（应用由 customInstall 在安装结束时自动重新打开）。 */
!macro customFinishPage
  Function EsprinFinishPagePre
    ${If} $EsprinUpgradeMode == "1"
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE EsprinFinishPagePre
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customPageAfterChangeDir

  Page custom EsprinDataDirPageCreate EsprinDataDirPageLeave

  /* 安装进度页：升级时把页头与窗口标题换成“正在更新…”，
     用户因此只会看到一个进度条加一行提示，不需要任何点选。
     这个宏恰好在本页声明（!insertmacro MUI_PAGE_INSTFILES）之前展开，
     所以这里定义的 SHOW 回调会被进度页取走。 */
  Function EsprinInstFilesPageShow
    ${If} $EsprinUpgradeMode == "1"
      !insertmacro MUI_HEADER_TEXT "正在更新 Esprin Nemo" "更新完成后应用会自动重新打开，请稍候…"
      SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:正在更新 Esprin Nemo…"
    ${EndIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW EsprinInstFilesPageShow

  Function EsprinToSlash
    StrCpy $1 ""
    StrLen $2 $0
    StrCpy $3 0
    EsprinToSlashLoop:
      ${If} $3 >= $2
        Return
      ${EndIf}
      StrCpy $4 $0 1 $3
      ${If} $4 == "\"
        StrCpy $1 "$1/"
      ${Else}
        StrCpy $1 "$1$4"
      ${EndIf}
      IntOp $3 $3 + 1
      Goto EsprinToSlashLoop
  FunctionEnd

  Function EsprinIsInsideDir
    StrCpy $3 "0"
    StrLen $4 $2
    ${If} $4 == 0
      Return
    ${EndIf}
    StrCpy $5 $1 $4
    ${If} $5 == $2
      StrCpy $5 $1 1 $4
      ${If} $5 == "/"
        StrCpy $3 "1"
      ${ElseIf} $5 == ""
        StrCpy $3 "1"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function EsprinDataDirPageCreate
    # 静默安装（/S）与应用内更新（--upgrade）都不需要这个向导页，
    # 这里提前 Abort，避免在无界面环境下创建控件失败导致整次安装被中断。
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${If} $EsprinUpgradeMode == "1"
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${If} ${FileExists} "${ESPRIN_DATA_PATH_FILE}"
      StrCpy $EsprinDataDirMode "keep"
      ${NSD_CreateLabel} 0 0 100% 58u "已存在数据位置记录：$\r$\n%APPDATA%\esprin_nemo\data_path.json$\r$\n$\r$\n本次安装不会修改它。如需更换笔记与配置的存放位置，请在应用内“设置 → 数据存放位置”中更改。"
      Pop $0
      nsDialogs::Show
      Return
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 15u "请选择笔记与配置文件的存放位置，也可在安装后到设置更改"
    Pop $0

    ${NSD_CreateCheckBox} 0 20u 100% 10u "使用默认位置（%APPDATA%\esprin_nemo\data）"
    Pop $EsprinDataDirCheckBox
    ${If} $EsprinDataDirMode != "custom"
      StrCpy $EsprinDataDirMode "default"
    ${EndIf}
    ${If} $EsprinDataDirMode == "default"
      ${NSD_Check} $EsprinDataDirCheckBox
    ${EndIf}

    ${NSD_CreateLabel} 0 34u 100% 15u "自定义位置（取消上方勾选后生效）："
    Pop $0

    StrCpy $1 "$DOCUMENTS\Esprin Nemo"
    ${If} $EsprinDataDirPath != ""
      StrCpy $1 "$EsprinDataDirPath"
    ${EndIf}
    ${NSD_CreateDirRequest} 0 50u 100% 12u "$1"
    Pop $EsprinDataDirPathEdit

    ${NSD_CreateLabel} 0 68u 100% 24u "数据目录保存 config.json、notes 与 todos 目录下的 Markdown 笔记与待办、以及 ai_chats 目录下的 AI 对话，请勿选择安装目录本身或其子目录。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function EsprinDataDirPageLeave
    # 静默安装与应用内更新下不询问数据位置：保持 $EsprinDataDirMode 为空，
    # customInstall 因此不会改写 %APPDATA%\esprin_nemo\data_path.json。
    ${If} ${Silent}
      Return
    ${EndIf}
    ${If} $EsprinUpgradeMode == "1"
      Return
    ${EndIf}

    ${If} $EsprinDataDirMode == "keep"
      Return
    ${EndIf}

    ${NSD_GetState} $EsprinDataDirCheckBox $0
    ${If} $0 == 1
      StrCpy $EsprinDataDirMode "default"
      StrCpy $EsprinDataDirPath ""
      Return
    ${EndIf}

    ${NSD_GetText} $EsprinDataDirPathEdit $1
    ${If} $1 == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择数据存放位置，或勾选“使用默认位置”。"
      Abort
    ${EndIf}

    StrCpy $0 "$1"
    Call EsprinToSlash
    StrCpy $EsprinDataDirPath "$1"

    StrCpy $0 "$INSTDIR"
    Call EsprinToSlash
    StrCpy $2 "$1"
    StrCpy $1 "$EsprinDataDirPath"
    Call EsprinIsInsideDir
    ${If} $3 == "1"
      MessageBox MB_OK|MB_ICONEXCLAMATION "数据存放位置不能是安装目录（$INSTDIR）或其子目录，请另选一个位置。"
      Abort
    ${EndIf}

    StrCpy $5 "0"
    ${If} ${FileExists} "$EsprinDataDirPath/config.json"
      StrCpy $5 "1"
    ${ElseIf} ${FileExists} "$EsprinDataDirPath/notes/*.*"
      StrCpy $5 "1"
    ${ElseIf} ${FileExists} "$EsprinDataDirPath/todos/*.*"
      StrCpy $5 "1"
    ${EndIf}
    ${If} $5 == "1"
      MessageBox MB_OK|MB_ICONINFORMATION "所选位置已存在 Esprin Nemo 数据：$\r$\n$EsprinDataDirPath$\r$\n$\r$\n应用会直接使用其中的笔记与配置，不会覆盖任何文件。"
    ${EndIf}

    StrCpy $EsprinDataDirMode "custom"
  FunctionEnd

!macroend

!macro customInstall
  ${If} $EsprinDataDirMode == "custom"
    Push $0
    Push $1
    CreateDirectory "$APPDATA\esprin_nemo"
    ClearErrors
    FileOpen $0 "${ESPRIN_DATA_PATH_FILE}" w
    ${IfNot} ${Errors}
      StrCpy $1 "$EsprinDataDirPath"
      FileWrite $0 "{$\r$\n"
      FileWrite $0 '  "dataDir": "$1"$\r$\n'
      FileWrite $0 "}$\r$\n"
      FileClose $0
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}

  # 应用内更新：文件已全部就绪，这里把应用重新打开（升级时不显示“完成”页，
  # 也就没有向导自带的“运行应用”勾选，重开动作由安装器自己做）。
  ${If} $EsprinUpgradeMode == "1"
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${EndIf}
!macroend
