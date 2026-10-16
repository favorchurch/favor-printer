import Foundation
import Testing

/// The signing inputs for each configuration live in plain files. A wrong type or method there fails only at install
/// or upload time on a real device, so these tests pin the values the README documents.
struct DistributionConfigTests {
    private static let ios = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()

    private static func plist(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: ios.appending(path: path))
        return try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    private static func idVendor(_ path: String) throws -> Any? {
        let entitlements = try plist(path)
        let usb = try #require(entitlements["com.apple.developer.driverkit.transport.usb"] as? [[String: Any]])
        return usb.first?["idVendor"]
    }

    @Test func theTestFlightDextNamesZebraAsAnIntegerAndDevelopmentKeepsTheWildcard() throws {
        #expect(try Self.idVendor("FavorPrinterDriver/FavorPrinterDriver-TestFlight.entitlements") as? Int == 2655)
        #expect(try Self.idVendor("FavorPrinterDriver/FavorPrinterDriver.entitlements") as? String == "*")
    }

    @Test func theDextMatchesTheSameVendorTheTestFlightEntitlementNames() throws {
        let personalities = try #require(Self.plist("FavorPrinterDriver/Info.plist")["IOKitPersonalities"] as? [String: [String: Any]])
        #expect(personalities.values.allSatisfy { $0["idVendor"] as? Int == 2655 })
    }

    @Test func theTestFlightExportTargetsAppStoreConnectForTheTeam() throws {
        let options = try Self.plist("Config/ExportOptions-TestFlight.plist")
        #expect(options["method"] as? String == "app-store-connect")
        #expect(options["teamID"] as? String == "3JJ4492TV8")
        #expect(options["signingStyle"] as? String == "automatic")
        #expect(options["manageAppVersionAndBuildNumber"] as? Bool == false)
        #expect(try Self.plist("Config/ExportOptions.plist")["method"] as? String == "debugging")
    }
}
