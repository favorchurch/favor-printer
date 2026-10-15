import Foundation

/// IOReturn values the transport reasons about. IOKit spells them as macros (`iokit_common_err(0x2c0)`), which
/// Swift cannot import, so they are written out here from IOKit/IOReturn.h.
enum IOReturnCode {
    private static func common(_ code: UInt32) -> Int32 { Int32(bitPattern: 0xE000_0000 | code) }

    static let success: Int32 = 0
    static let noDevice = common(0x2c0)
    static let offline = common(0x2d7)
    static let notAttached = common(0x2d9)
    static let timeout = common(0x2d6)
    static let notReady = common(0x2d8)
    static let notFound = common(0x2f0)
    /// kIOUSBTransactionTimeout (sub_iokit_usb 0x51): what a USB transfer reports when its completion timeout fires.
    static let usbTransactionTimeout = Int32(bitPattern: 0xE000_4051)
}

/// Maps IOKit results onto `UsbTransportError`. Pure, so every row is testable without hardware.
extension UsbTransportError {
    static func isDetached(_ code: Int32) -> Bool {
        code == IOReturnCode.noDevice || code == IOReturnCode.notAttached || code == IOReturnCode.offline
    }

    static func isTimeout(_ code: Int32) -> Bool {
        code == IOReturnCode.timeout || code == IOReturnCode.usbTransactionTimeout
    }

    /// `IOServiceOpen` failed.
    static func forOpen(code: Int32) -> UsbTransportError {
        isDetached(code) ? .notAttached : .openFailed(code: code)
    }

    /// Result of one send. `callCode` is `IOConnectCallMethod`'s return, `driverCode` the USB result the dext
    /// reports next to `written`. `written` counts every byte accepted so far, including earlier chunks of the
    /// same payload. A detach after some bytes went out stays `writeFailed` so that the byte count survives.
    static func writeOutcome(callCode: Int32, driverCode: Int32, written: Int, expected: Int) -> Result<Int, UsbTransportError> {
        let code = callCode != IOReturnCode.success ? callCode : driverCode
        if code != IOReturnCode.success {
            if isDetached(code) && written == 0 { return .failure(.notAttached) }
            return .failure(.writeFailed(code: code, bytesWritten: written))
        }
        return written >= expected ? .success(written) : .failure(.shortWrite(written: written, expected: expected))
    }

    static func readOutcome(callCode: Int32, driverCode: Int32, data: Data) -> Result<Data, UsbTransportError> {
        let code = callCode != IOReturnCode.success ? callCode : driverCode
        if code == IOReturnCode.success { return .success(data) }
        if isDetached(code) { return .failure(.notAttached) }
        if isTimeout(code) { return .failure(.timeout) }
        return .failure(.readFailed(code: code))
    }
}
