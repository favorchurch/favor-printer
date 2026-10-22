# Read-only Win32_Printer inventory for issue #42. No driver, queue, job,
# enrollment, credential, registry, or service mutation is performed.
# Run locally on Windows; do not change the machine execution policy for this.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $printers = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
        [ordered]@{
            queueName = [string]$_.Name
            driverName = [string]$_.DriverName
            portName = [string]$_.PortName
            pnpDeviceId = if ($null -eq $_.PNPDeviceID) { $null } else { [string]$_.PNPDeviceID }
            isLocal = if ($null -eq $_.Local) { $null } else { [bool]$_.Local }
            isNetwork = if ($null -eq $_.Network) { $null } else { [bool]$_.Network }
            workOffline = if ($null -eq $_.WorkOffline) { $null } else { [bool]$_.WorkOffline }
            printerStatus = if ($null -eq $_.PrinterStatus) { $null } else { [int]$_.PrinterStatus }
            detectedErrorState = if ($null -eq $_.DetectedErrorState) { $null } else { [int]$_.DetectedErrorState }
        }
    })
    [ordered]@{
        schemaVersion = 1
        source = 'Win32_Printer'
        printers = $printers
    } | ConvertTo-Json -Depth 4 -Compress
} catch {
    # Avoid printing queue names, PnP identifiers, or arbitrary provider output.
    [Console]::Error.WriteLine('Windows printer inventory failed; inspect CIM access locally.')
    exit 1
}
