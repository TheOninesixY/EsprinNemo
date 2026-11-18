$ErrorActionPreference = 'Stop'

Add-Type -Namespace EsprinNemo -Name DesktopLayer -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@

$BOTTOM = [IntPtr]1

$FLAGS = 0x0213

$reader = [Console]::In
while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }

    $value = $line.Trim()
    if ($value -eq '') { continue }
    if ($value -eq 'quit') { break }

    try {
        $hwnd = [IntPtr]([Int64]$value)
        if (-not [EsprinNemo.DesktopLayer]::SetWindowPos($hwnd, $BOTTOM, 0, 0, 0, 0, $FLAGS)) {
            $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            [Console]::Error.WriteLine("SetWindowPos failed (hwnd=$value code=$code)")
        }
    } catch {
        [Console]::Error.WriteLine("bad window handle: $value")
    }
}