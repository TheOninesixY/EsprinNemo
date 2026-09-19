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
!endif

!macro customPageAfterChangeDir

  Page custom EsprinDataDirPageCreate EsprinDataDirPageLeave

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

    ${NSD_CreateLabel} 0 68u 100% 24u "数据目录保存 config.json、notes 目录下的 Markdown 笔记与 ai_chats 目录下的 AI 对话，请勿选择安装目录本身或其子目录。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function EsprinDataDirPageLeave
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
!macroend
