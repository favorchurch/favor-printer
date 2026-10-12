import Foundation

/// Wire types for docs/native-api/v1.md device endpoints.

enum DeviceStatus: String, Codable, Sendable, Equatable {
    case pending
    case approved
    case revoked
}

struct DeviceGrant: Codable, Sendable, Equatable {
    let id: String
    let campusId: Int
    let label: String
    let status: DeviceStatus
    let createdAt: Date
    let approvedAt: Date?
    let revokedAt: Date?
}

struct DeviceRegistration: Sendable, Equatable {
    let grant: DeviceGrant
    /// Returned exactly once by the server. Callers must put it in the Keychain and nowhere else.
    let token: String
}

struct RegisterRequest: Encodable, Sendable {
    let campusId: Int
    let label: String
}

struct RegisterResponse: Decodable, Sendable {
    let apiVersion: Int
    let grant: DeviceGrant
    let token: String
}

struct StatusResponse: Decodable, Sendable {
    let apiVersion: Int
    let grant: DeviceGrant
}

/// Every error code in the contract's table.
enum APIErrorCode: String, Sendable, Equatable, CaseIterable {
    case badRequest = "bad_request"
    case missingToken = "missing_token"
    case malformedToken = "malformed_token"
    case unknownDevice = "unknown_device"
    case devicePending = "device_pending"
    case deviceRevoked = "device_revoked"
    case wrongCampus = "wrong_campus"
    case definitionForbidden = "definition_forbidden"
    case occurrenceForbidden = "occurrence_forbidden"
    case printerForbidden = "printer_forbidden"
    case throttled
    case unavailable
}

struct ErrorEnvelope: Decodable, Sendable {
    let error: String
}

enum APIError: Error, Sendable, Equatable {
    /// HTTP error with a code from the contract.
    case server(status: Int, code: APIErrorCode)
    /// HTTP error whose status or code is not in the contract.
    case unexpected(status: Int, code: String?)
    /// The request never produced an HTTP response.
    case transport
    /// A 2xx whose body does not match the contract.
    case invalidResponse
    /// Rejected on the device before any request was made.
    case invalidInput(String)
    case insecureBaseURL

    /// The server no longer accepts this credential: any 401, or a revoked grant.
    var invalidatesCredential: Bool {
        switch self {
        case .server(let status, let code):
            return status == 401 || code == .deviceRevoked
        case .unexpected(let status, _):
            return status == 401
        default:
            return false
        }
    }

    /// Safe to show a volunteer. Never includes server text.
    var message: String {
        switch self {
        case .server(_, let code):
            switch code {
            case .throttled: "Too many attempts. Wait ten minutes and try again."
            case .unavailable: "Favor RSVP is unavailable. Try again shortly."
            case .badRequest: "The request was rejected. Check the campus and name."
            case .devicePending: "This iPad is waiting for approval."
            case .deviceRevoked: "This iPad was removed. Register it again."
            case .missingToken, .malformedToken, .unknownDevice: "This iPad is not registered. Register it again."
            case .wrongCampus: "This iPad can only check in people at its own campus."
            case .definitionForbidden: "That check-in is turned off or belongs to another campus. Pick another."
            case .occurrenceForbidden: "That service is not open to this iPad. Go back and pick another."
            case .printerForbidden: "That printer is not available to this iPad. Pick another."
            }
        case .unexpected, .invalidResponse: "Unexpected response from Favor RSVP."
        case .transport: "Could not reach Favor RSVP. Check the network."
        case .invalidInput(let reason): reason
        case .insecureBaseURL: "The RSVP address must use HTTPS."
        }
    }
}
