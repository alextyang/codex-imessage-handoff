import Foundation
import Security

private let tagPrefix = "com.codex.imessage-handoff.remote-control."
private let algorithm = "ecdsa_p256_sha256"
private let protectionClass = "os_protected_nonextractable"

private struct HelperFailure: Error {
    let message: String
}

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

private func statusMessage(_ operation: String, _ status: OSStatus) -> String {
    let detail = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    return "\(operation) failed: \(detail) (\(status))"
}

private func tagData(_ keyId: String) throws -> Data {
    guard UUID(uuidString: keyId) != nil else { throw HelperFailure(message: "invalid key id") }
    return Data((tagPrefix + keyId.lowercased()).utf8)
}

private func privateKey(_ keyId: String) throws -> SecKey {
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag: try tagData(keyId),
        kSecReturnRef: true,
        kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let key = result as! SecKey? else {
        throw HelperFailure(message: statusMessage("key lookup", status))
    }
    return key
}

private func spkiData(_ key: SecKey) throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(key) else {
        throw HelperFailure(message: "public key is unavailable")
    }
    var error: Unmanaged<CFError>?
    guard let point = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
        if let error { throw error.takeRetainedValue() }
        throw HelperFailure(message: "public key export failed")
    }
    guard point.count == 65, point.first == 0x04 else {
        throw HelperFailure(message: "unexpected P-256 public key representation")
    }
    // SubjectPublicKeyInfo(ecPublicKey, prime256v1) followed by the uncompressed
    // ANSI X9.63 public point.
    let prefix = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d,
        0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01,
        0x07, 0x03, 0x42, 0x00,
    ])
    return prefix + point
}

private func publicRecord(_ keyId: String, _ key: SecKey) throws -> [String: Any] {
    return [
        "keyId": keyId.lowercased(),
        "publicKeySpkiDerBase64": try spkiData(key).base64EncodedString(),
        "algorithm": algorithm,
        "protectionClass": protectionClass,
    ]
}

private func createKey() throws -> [String: Any] {
    let keyId = UUID().uuidString.lowercased()
    let privateAttributes: [CFString: Any] = [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: try tagData(keyId),
        kSecAttrLabel: "Codex iMessage Remote Access",
        kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        kSecAttrIsExtractable: false,
    ]
    let attributes: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits: 256,
        kSecPrivateKeyAttrs: privateAttributes,
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
        if let error { throw error.takeRetainedValue() }
        throw HelperFailure(message: "key creation failed")
    }
    return try publicRecord(keyId, key)
}

private func sign(_ keyId: String, _ payloadBase64: String) throws -> [String: Any] {
    guard let payload = Data(base64Encoded: payloadBase64) else {
        throw HelperFailure(message: "invalid signing payload")
    }
    let key = try privateKey(keyId)
    let signingAlgorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
    guard SecKeyIsAlgorithmSupported(key, .sign, signingAlgorithm) else {
        throw HelperFailure(message: "P-256 SHA-256 signing is unavailable")
    }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(key, signingAlgorithm, payload as CFData, &error) as Data? else {
        if let error { throw error.takeRetainedValue() }
        throw HelperFailure(message: "signature failed")
    }
    return [
        "signatureDerBase64": signature.base64EncodedString(),
        "algorithm": algorithm,
    ]
}

private func deleteKey(_ keyId: String) throws -> [String: Any] {
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag: try tagData(keyId),
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        throw HelperFailure(message: statusMessage("key deletion", status))
    }
    return ["deleted": status == errSecSuccess]
}

private func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw HelperFailure(message: "missing command") }
    switch command {
    case "create":
        guard arguments.count == 1 else { throw HelperFailure(message: "usage: create") }
        try emit(createKey())
    case "get":
        guard arguments.count == 2 else { throw HelperFailure(message: "usage: get key-id") }
        let key = try privateKey(arguments[1])
        try emit(publicRecord(arguments[1], key))
    case "sign":
        guard arguments.count == 3 else { throw HelperFailure(message: "usage: sign key-id payload-base64") }
        try emit(sign(arguments[1], arguments[2]))
    case "delete":
        guard arguments.count == 2 else { throw HelperFailure(message: "usage: delete key-id") }
        try emit(deleteKey(arguments[1]))
    default:
        throw HelperFailure(message: "unsupported command")
    }
} catch let failure as HelperFailure {
    fail(failure.message)
} catch {
    fail(String(describing: error))
}
