import Foundation

struct CompanionStatus: Codable, Equatable {
    var macName: String
    var hostConnected: Bool
    var modelName: String?
    var engineState: String
    var tokensPerSecond: Double?
    var memoryUsedGB: Double?
    var memoryTotalGB: Double?
    var activeRequests: Int
}

struct CompanionModel: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var size: String?
    var state: String
    var detail: String?
    var selected: Bool? = nil
}

struct CompanionChat: Codable, Identifiable, Equatable {
    var id: String
    var title: String
}

struct ChatMessage: Codable, Identifiable, Equatable {
    var id: String
    var role: String
    var content: String
}

struct PairedConnection: Codable, Equatable {
    var baseURL: URL
    var macName: String
    var fingerprint: String
    var token: String
}

enum CompanionError: LocalizedError {
    case invalidInvitation(String)
    case server(String)
    case unpaired
    case keychain(Int32)
    var errorDescription: String? {
        switch self {
        case .invalidInvitation(let message), .server(let message): return message
        case .unpaired: return "Pair with your Mac to continue."
        case .keychain: return "Your connection could not be saved securely. Please try pairing again."
        }
    }
}

struct PairingInvitation: Equatable {
    var url: String
    var code: String
    var fingerprint: String

    static func validatedURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              (parts.path.isEmpty || parts.path == "/"), (parts.port ?? 443) > 0, (parts.port ?? 443) <= 65535 else {
            throw CompanionError.invalidInvitation("Enter the HTTPS address shown on your Mac, including its port.")
        }
        return url
    }

    static func normalizedFingerprint(_ value: String) throws -> String {
        let fingerprint = value.replacingOccurrences(of: ":", with: "").lowercased()
        guard fingerprint.count == 64, fingerprint.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
            throw CompanionError.invalidInvitation("The Mac certificate fingerprint must contain 64 hexadecimal characters. Scan the QR code to fill it in.")
        }
        return fingerprint
    }

    static func parse(_ value: String) throws -> PairingInvitation {
        guard let parts = URLComponents(string: value), parts.scheme == "strata", parts.host == "pair" else {
            throw CompanionError.invalidInvitation("This is not a Strata pairing code. Open Strata Companion on your Mac and scan its QR code.")
        }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else {
            throw CompanionError.invalidInvitation("The pairing code contains duplicate fields.")
        }
        func item(_ key: String) -> String? { items.first { $0.name == key }?.value }
        let address: String
        if let url = item("url") { address = url }
        else if let host = item("host"), let port = item("port"), let number = Int(port), (1...65535).contains(number) {
            var endpoint = URLComponents(); endpoint.scheme = "https"; endpoint.host = host; endpoint.port = number
            guard let url = endpoint.url else { throw CompanionError.invalidInvitation("The Mac address is invalid.") }
            address = url.absoluteString
        } else { throw CompanionError.invalidInvitation("The pairing code is missing the Mac address.") }
        _ = try validatedURL(address)
        guard let code = item("code"), code.count == 6, code.allSatisfy({ $0 >= "0" && $0 <= "9" }),
              let pin = item("fingerprint") else {
            throw CompanionError.invalidInvitation("The pairing code is incomplete. Generate a new code on your Mac.")
        }
        return PairingInvitation(url: address, code: code, fingerprint: try normalizedFingerprint(pin))
    }
}
