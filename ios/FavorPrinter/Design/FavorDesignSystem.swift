import SwiftUI
import UIKit

// Palette and type roles follow the Favor Design System skill: brand-core.md and favor-tokens.json.
enum FavorColor {
    static let paper = adaptive(light: UIColor(hex: 0xFEF1E8), dark: .systemBackground)
    static let surface = adaptive(light: .white, dark: .secondarySystemBackground)
    static let ink = adaptive(light: UIColor(hex: 0x121411), dark: .label)
    static let mutedInk = adaptive(light: UIColor(hex: 0x625F59), dark: .secondaryLabel)
    static let rule = adaptive(light: UIColor(hex: 0xDED8D1), dark: .separator)
    static let orange = adaptive(light: UIColor(hex: 0xF45500), dark: .systemOrange)
    static let blue = adaptive(light: UIColor(hex: 0x007FAE), dark: .systemBlue)
    static let yellow = adaptive(light: UIColor(hex: 0xFFB42A), dark: .systemYellow)
    static let positive = adaptive(light: UIColor(hex: 0x34735A), dark: .systemGreen)
    static let warning = adaptive(light: UIColor(hex: 0xA65B00), dark: .systemOrange)

    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
}

enum FavorType {
    static func display(_ size: CGFloat) -> Font {
        .custom("Favorvetica", size: size, relativeTo: .largeTitle)
    }

    static func utility(_ size: CGFloat = 16, weight: Font.Weight = .regular) -> Font {
        .custom("Favor Sans", size: size, relativeTo: .body).weight(weight)
    }
}

enum FavorSpace {
    static let xSmall: CGFloat = 4
    static let small: CGFloat = 8
    static let medium: CGFloat = 16
    static let large: CGFloat = 24
    static let section: CGFloat = 32
}

struct FavorCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(FavorSpace.large)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(FavorColor.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(FavorColor.rule, lineWidth: 1)
                    .allowsHitTesting(false)
            }
    }
}

struct FavorStatusBadge: View {
    enum Status {
        case ready
        case attention
        case unavailable

        var title: String {
            switch self {
            case .ready: "Ready"
            case .attention: "Needs attention"
            case .unavailable: "Unavailable"
            }
        }

        var symbol: String {
            switch self {
            case .ready: "checkmark.circle.fill"
            case .attention: "exclamationmark.triangle.fill"
            case .unavailable: "minus.circle.fill"
            }
        }

        var symbolColor: Color {
            switch self {
            case .ready: FavorColor.positive
            case .attention: FavorColor.warning
            case .unavailable: FavorColor.mutedInk
            }
        }
    }

    let status: Status

    var body: some View {
        Label {
            Text(status.title)
                .font(FavorType.utility(14, weight: .semibold))
                .foregroundStyle(FavorColor.ink)
        } icon: {
            Image(systemName: status.symbol)
                .foregroundStyle(status.symbolColor)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, FavorSpace.medium)
        .frame(minHeight: 44)
        .background(FavorColor.surface, in: Capsule())
        .overlay { Capsule().stroke(FavorColor.rule, lineWidth: 1) }
        .accessibilityElement(children: .combine)
    }
}

struct FavorPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(FavorType.utility(16, weight: .semibold))
            .foregroundStyle(FavorColor.ink)
            .padding(.horizontal, FavorSpace.large)
            .frame(minWidth: 44, minHeight: 44)
            .background(FavorColor.orange.opacity(configuration.isPressed ? 0.82 : 1), in: Capsule())
            .contentShape(Capsule())
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
