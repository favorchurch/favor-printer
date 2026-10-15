#if DEBUG
import Foundation

/// What the DEBUG "Read printer status" control shows: how many bytes the printer answered `~HS` with and their
/// printable ASCII, or the typed reason there was no answer. Never ZPL or label text.
enum PrinterStatusReading: Sendable, Equatable {
    case reply(byteCount: Int, text: String)
    case failure(UsbTransportError)
    /// Another read is already running.
    case busy

    static let command = Data("~HS".utf8)

    /// Writes `~HS`, then reads. A failed write is reported as it is and nothing is read.
    static func read(from transport: any UsbPrinterTransport) async -> PrinterStatusReading {
        if case .failure(let error) = await transport.send(command) { return .failure(error) }
        switch await transport.readStatus() {
        case .success(let data): return .reply(byteCount: data.count, text: printable(data))
        case .failure(let error): return .failure(error)
        }
    }

    /// Printable ASCII as is, CR and LF as line breaks, everything else (the STX/ETX framing, stray bytes) as ".".
    static func printable(_ data: Data) -> String {
        var text = ""
        for byte in data {
            switch byte {
            case 0x20...0x7E: text.append(Character(UnicodeScalar(byte)))
            case 0x0A, 0x0D: if text.last != "\n" { text.append("\n") }
            default: text.append(".")
            }
        }
        return text
    }

    /// One line for the host screen.
    var summary: String {
        switch self {
        case .reply(let count, let text): "\(count) bytes\n\(text)"
        case .failure(let error): "Failed: \(error)"
        case .busy: "Already reading"
        }
    }
}
#endif
