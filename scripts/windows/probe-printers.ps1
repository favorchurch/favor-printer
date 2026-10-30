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

try {
    $printers = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
        $serial = if ($_.Local -eq $true -and $_.Network -eq $false -and $_.PortName -match '^USB[0-9]{3,}$') {
            Get-VerifiedZebraUsbSerial ([string]$_.PNPDeviceID)
        } else { $null }
        [ordered]@{
            queueName = [string]$_.Name
            driverName = [string]$_.DriverName
            portName = [string]$_.PortName
            pnpDeviceId = if ($null -eq $_.PNPDeviceID) { $null } else { [string]$_.PNPDeviceID }
            verifiedUsbSerial = $serial
            serialEvidence = if ($null -eq $serial) { $null } else { 'unique-usb-parent' }
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
