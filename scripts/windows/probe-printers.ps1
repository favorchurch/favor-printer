# Read-only Win32_Printer inventory for issue #42. No driver, queue, job,
# enrollment, credential, registry, or service mutation is performed.
# Run locally on Windows; do not change the machine execution policy for this.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Only the USB parent with Windows CM_DEVCAP_UNIQUEID is evidence of a real
# device-provided serial. USBPRINT\...\7&... and USB001 are NOT serial numbers.
# No fallback to guessed PnP fragments: unsupported drivers stay unenrollable.
function Get-VerifiedZebraUsbSerial([string]$instanceId) {
    if ([string]::IsNullOrWhiteSpace($instanceId)) { return $null }
    $seen = @{}
    for ($hop = 0; $hop -lt 6; $hop++) {
        if ($seen.ContainsKey($instanceId)) { return $null }
        $seen[$instanceId] = $true
        try {
            $device = Get-PnpDevice -InstanceId $instanceId -ErrorAction Stop
            if ($null -eq $device -or $device.Status -ne 'OK') { return $null }
            $match = [regex]::Match($instanceId, '^USB\\VID_0A5F&PID_[0-9A-F]{4}\\([A-Za-z0-9._-]{1,64})$', 'IgnoreCase')
            if ($match.Success) {
                $cap = Get-PnpDeviceProperty -InstanceId $instanceId -KeyName 'DEVPKEY_Device_Capabilities' -ErrorAction Stop
                if (($null -eq $cap.Data) -or (([int]$cap.Data -band 16) -ne 16)) { return $null }
                return $match.Groups[1].Value
            }
            $parent = Get-PnpDeviceProperty -InstanceId $instanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction Stop
            $instanceId = [string]$parent.Data
            if ([string]::IsNullOrWhiteSpace($instanceId)) { return $null }
        } catch { return $null }
    }
    return $null
}

# Port binding (review F1, wrong-printer safety). The ZDesigner driver leaves
# Win32_Printer.PNPDeviceID empty (seen on a real ZD421, 2026-11-20), and a
# PNPDeviceID that is present names a device but not the port the queue sends
# to. The USB print class names each printer USBPRINT\<model>\<n>&...&<port>,
# for example USBPRINT\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\6&1DBA03D&0&USB001
# for the queue on USB001. So the device behind a queue is the present USBPRINT
# device whose ID ends in "&" + that queue's PortName, and nothing else:
# - "&" is the delimiter, so USB002 never matches ...&USB001 (or ...&USB0021).
# - Exactly one such device is required. Zero or two means no serial.
# - Windows can hand a port name to a different printer after a replug. The
#   suffix only finds whichever device holds the port now; the parent walk then
#   still needs a present Zebra USB parent with a unique serial, and the app
#   still refuses to print unless that serial is the one it paired with.
# The app checks the same rule again on usbPrintInstanceId (windowsDiscovery.ts).
function Test-UsbPrintInstanceOnPort([string]$instanceId, [string]$portName) {
    if ([string]::IsNullOrWhiteSpace($instanceId) -or $portName -notmatch '^USB[0-9]{3,}$') { return $false }
    return $instanceId.StartsWith('USBPRINT\', [System.StringComparison]::OrdinalIgnoreCase) -and
        $instanceId.EndsWith('&' + $portName, [System.StringComparison]::OrdinalIgnoreCase)
}

function Select-UsbPrintInstanceForPort([string]$portName, [string[]]$instanceIds) {
    $found = @($instanceIds | Where-Object { Test-UsbPrintInstanceOnPort $_ $portName })
    if ($found.Count -ne 1) { return $null }
    return [string]$found[0]
}

# One PnP enumeration per run, and only when a queue needs it. A failure here
# leaves the list empty, which gives no serial (fail closed), not a failed probe.
$script:presentUsbPrintIds = $null
function Get-PresentUsbPrintInstanceIds {
    if ($null -eq $script:presentUsbPrintIds) {
        try {
            $script:presentUsbPrintIds = @(Get-PnpDevice -PresentOnly -ErrorAction Stop |
                Where-Object { $_.Status -eq 'OK' -and ([string]$_.InstanceId).StartsWith('USBPRINT\', [System.StringComparison]::OrdinalIgnoreCase) } |
                ForEach-Object { [string]$_.InstanceId })
        } catch { $script:presentUsbPrintIds = @() }
    }
    return ,$script:presentUsbPrintIds
}

try {
    $printers = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
        $queue = $_
        $usbPrint = $null
        $serial = $null
        $evidence = $null
        if ($queue.Local -eq $true -and $queue.Network -eq $false -and $queue.PortName -match '^USB[0-9]{3,}$') {
            $port = [string]$queue.PortName
            $pnp = [string]$queue.PNPDeviceID
            if ([string]::IsNullOrWhiteSpace($pnp)) {
                $usbPrint = Select-UsbPrintInstanceForPort $port (Get-PresentUsbPrintInstanceIds)
                if ($null -ne $usbPrint) {
                    $serial = Get-VerifiedZebraUsbSerial $usbPrint
                    if ($null -ne $serial) { $evidence = 'usbprint-port' }
                }
            } elseif (Test-UsbPrintInstanceOnPort $pnp $port) {
                # A PNPDeviceID on another port is not this queue's printer: no serial.
                $usbPrint = $pnp
                $serial = Get-VerifiedZebraUsbSerial $pnp
                if ($null -ne $serial) { $evidence = 'unique-usb-parent' }
            }
        }
        [ordered]@{
            queueName = [string]$queue.Name
            driverName = [string]$queue.DriverName
            portName = [string]$queue.PortName
            pnpDeviceId = if ($null -eq $queue.PNPDeviceID) { $null } else { [string]$queue.PNPDeviceID }
            usbPrintInstanceId = $usbPrint
            verifiedUsbSerial = $serial
            serialEvidence = $evidence
            isLocal = if ($null -eq $queue.Local) { $null } else { [bool]$queue.Local }
            isNetwork = if ($null -eq $queue.Network) { $null } else { [bool]$queue.Network }
            workOffline = if ($null -eq $queue.WorkOffline) { $null } else { [bool]$queue.WorkOffline }
            printerStatus = if ($null -eq $queue.PrinterStatus) { $null } else { [int]$queue.PrinterStatus }
            detectedErrorState = if ($null -eq $queue.DetectedErrorState) { $null } else { [int]$queue.DetectedErrorState }
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
