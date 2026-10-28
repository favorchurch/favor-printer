# Favor Printer RAW ZPL Windows helper. Never logs or interprets ZPL.
# Run with normal, approved Windows PowerShell execution policy.
param(
  [Parameter(Mandatory=$true)][ValidateSet('Print','Probe')][string]$Action,
  [Parameter(Mandatory=$true)][string]$PrinterName
)
$ErrorActionPreference = 'Stop'
if ($PrinterName.Length -lt 1 -or $PrinterName.Length -gt 127 -or
    $PrinterName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9 _().-]*$') {
  [Console]::Error.WriteLine('invalid-printer')
  exit 2
}
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FavorWinspool {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DocInfo {
        [MarshalAs(UnmanagedType.LPWStr)] public string name;
        [MarshalAs(UnmanagedType.LPWStr)] public string output;
        [MarshalAs(UnmanagedType.LPWStr)] public string datatype;
    }
    [DllImport("winspool.drv", EntryPoint="OpenPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint StartDocPrinter(IntPtr handle, uint level, ref DocInfo info);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr handle, byte[] input, uint size, out uint written);
}
'@ -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine('spooler-api-unavailable')
  exit 3
}
$handle = [IntPtr]::Zero
if (-not [FavorWinspool]::OpenPrinter($PrinterName, [ref]$handle, [IntPtr]::Zero)) {
  [Console]::Error.WriteLine('printer-queue-unavailable')
  exit 4
}
$docStarted = $false
$pageStarted = $false
try {
  if ($Action -eq 'Probe') {
    [Console]::Out.WriteLine('FAVOR_QUEUE_FOUND')
    exit 0
  }
  $stream = [Console]::OpenStandardInput()
  $data = New-Object System.IO.MemoryStream
  $chunk = New-Object byte[] 8192
  $limit = 2 * 1024 * 1024
  while (($count = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
    if ($data.Length + $count -gt $limit) {
      [Console]::Error.WriteLine('label-too-large')
      exit 5
    }
    $data.Write($chunk, 0, $count)
  }
  $bytes = $data.ToArray()
  if ($bytes.Length -eq 0) { [Console]::Error.WriteLine('empty-label'); exit 5 }

  $doc = New-Object FavorWinspool+DocInfo
  $doc.name = 'Favor Printer Label'
  $doc.output = $null
  $doc.datatype = 'RAW'
  $id = [FavorWinspool]::StartDocPrinter($handle, 1, [ref]$doc)
  if ($id -eq 0) { throw 'start-doc-failed' }
  $docStarted = $true
  if (-not [FavorWinspool]::StartPagePrinter($handle)) { throw 'start-page-failed' }
  $pageStarted = $true
  [uint32]$written = 0
  if (-not [FavorWinspool]::WritePrinter($handle, $bytes, [uint32]$bytes.Length, [ref]$written) -or
      $written -ne $bytes.Length) { throw 'write-failed' }
  if (-not [FavorWinspool]::EndPagePrinter($handle)) { throw 'end-page-failed' }
  $pageStarted = $false
  if (-not [FavorWinspool]::EndDocPrinter($handle)) { throw 'end-doc-failed' }
  $docStarted = $false
  [Console]::Out.WriteLine('FAVOR_SPOOL_ACCEPTED')
  exit 0
} catch {
  [Console]::Error.WriteLine('spooler-submit-failed')
  exit 6
} finally {
  if ($pageStarted) { [void][FavorWinspool]::EndPagePrinter($handle) }
  if ($docStarted) { [void][FavorWinspool]::EndDocPrinter($handle) }
  if ($handle -ne [IntPtr]::Zero) { [void][FavorWinspool]::ClosePrinter($handle) }
}
