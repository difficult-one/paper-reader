!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 != 1
    MessageBox MB_OK|MB_ICONINFORMATION "系统可能缺少 Microsoft Visual C++ x64 运行库。如果翻译引擎无法启动，请运行安装目录 resources\runtime\pdf2zh\vc_redist17.x64.exe，然后重新打开阅读器。"
  ${EndIf}
!macroend
