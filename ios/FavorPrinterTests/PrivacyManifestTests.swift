import Foundation
import Testing
@testable import FavorPrinter

/// The app ships `PrivacyInfo.xcprivacy`. App Store Connect rejects an upload that uses a required-reason API without
/// declaring it, so these tests tie the manifest to what the app sources call.
struct PrivacyManifestTests {
    private enum Category: String, CaseIterable {
        case userDefaults = "NSPrivacyAccessedAPICategoryUserDefaults"
        case fileTimestamp = "NSPrivacyAccessedAPICategoryFileTimestamp"
        case diskSpace = "NSPrivacyAccessedAPICategoryDiskSpace"
        case systemBootTime = "NSPrivacyAccessedAPICategorySystemBootTime"

        /// Symbols Apple lists for the category, as whole-word patterns.
        var symbols: [String] {
            switch self {
            case .userDefaults:
                ["UserDefaults", "NSUserDefaults"]
            case .fileTimestamp:
                ["creationDate", "modificationDate", "contentModificationDate", "contentModificationDateKey", "creationDateKey",
                 "contentAccessDate", "contentAccessDateKey", "attributeModificationDate", "NSFileCreationDate",
                 "NSFileModificationDate", "fileModificationDate", "stat", "fstat", "lstat", "getattrlist", "getattrlistbulk",
                 "fgetattrlist", "fstatat"]
            case .diskSpace:
                ["volumeAvailableCapacity", "volumeAvailableCapacityKey", "volumeAvailableCapacityForImportantUsage",
                 "volumeAvailableCapacityForImportantUsageKey", "volumeAvailableCapacityForOpportunisticUsage",
                 "volumeTotalCapacity", "volumeTotalCapacityKey", "systemFreeSize", "systemSize", "NSFileSystemFreeSize",
                 "NSFileSystemSize", "statfs", "statvfs", "fstatfs", "fstatvfs"]
            case .systemBootTime:
                ["systemUptime", "mach_absolute_time", "mach_continuous_time", "clock_gettime_nsec_np"]
            }
        }
    }

    private static func categories(usedIn source: String) -> Set<Category> {
        let code = source.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        var found: Set<Category> = []
        for category in Category.allCases {
            let alternation = category.symbols.joined(separator: "|")
            if code.range(of: "\\b(\(alternation))\\b", options: .regularExpression) != nil { found.insert(category) }
        }
        return found
    }

    private static func manifest() throws -> [String: Any] {
        let url = try #require(Bundle(for: HostController.self).url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        return try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
    }

    private static func declared() throws -> [String: [String]] {
        let types = try #require(try manifest()["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        return Dictionary(
            uniqueKeysWithValues: types.map {
                ($0["NSPrivacyAccessedAPIType"] as? String ?? "", $0["NSPrivacyAccessedAPITypeReasons"] as? [String] ?? [])
            }
        )
    }

    @Test func manifestDeclaresNoTrackingAndNoCollectedData() throws {
        let manifest = try Self.manifest()
        #expect(manifest["NSPrivacyTracking"] as? Bool == false)
        #expect((manifest["NSPrivacyTrackingDomains"] as? [Any])?.isEmpty == true)
        #expect((manifest["NSPrivacyCollectedDataTypes"] as? [Any])?.isEmpty == true)
    }

    @Test func manifestDeclaresUserDefaultsWithAnAppOnlyReason() throws {
        #expect(try Self.declared()[Category.userDefaults.rawValue] == ["CA92.1"])
    }

    @Test func everyDeclaredCategoryHasAReason() throws {
        for (category, reasons) in try Self.declared() {
            #expect(!reasons.isEmpty, "\(category) has no reason")
        }
    }

    @Test func everyRequiredReasonAPIUsedInTheAppSourcesIsDeclared() throws {
        let sources = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "FavorPrinter")
        let enumerator = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        let declared = Set(try Self.declared().keys)
        var scanned = 0
        for case let url as URL in enumerator where ["swift", "m", "h"].contains(url.pathExtension) {
            scanned += 1
            for category in Self.categories(usedIn: try String(contentsOf: url, encoding: .utf8)) {
                #expect(declared.contains(category.rawValue), "\(url.lastPathComponent) uses \(category.rawValue) without declaring it")
            }
        }
        #expect(scanned > 10)
    }

    @Test func theScannerFindsEachCategory() {
        #expect(Self.categories(usedIn: "let d = try url.resourceValues(forKeys: [.creationDateKey])") == [.fileTimestamp])
        #expect(Self.categories(usedIn: "attrs[.systemFreeSize]") == [.diskSpace])
        #expect(Self.categories(usedIn: "ProcessInfo.processInfo.systemUptime") == [.systemBootTime])
        #expect(Self.categories(usedIn: "UserDefaults.standard.set(1, forKey: \"a\")") == [.userDefaults])
        #expect(Self.categories(usedIn: "// UserDefaults only in a comment\nlet statement = 1").isEmpty)
    }
}
