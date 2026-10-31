// Compile alongside the reference pin's Vendor/SwiftTerm/Sources/SwiftTerm/Colors.swift.
// This executes the native color algorithm; it does not maintain a desktop port.
import Foundation

struct PaletteInputError: Error, CustomStringConvertible {
    let description: String
}

func captures(_ pattern: String, in source: String) throws -> [String] {
    let regex = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
    return regex.matches(in: source, range: NSRange(source.startIndex..., in: source)).map {
        String(source[Range($0.range(at: 1), in: source)!])
    }
}

func one(_ pattern: String, in source: String) throws -> String {
    let values = try captures(pattern, in: source)
    guard values.count == 1 else {
        throw PaletteInputError(description: "Expected one native declaration for \(pattern), found \(values.count)")
    }
    return values[0]
}

func color(_ hex: String) throws -> Color {
    guard let value = UInt32(hex, radix: 16), hex.count == 6 else {
        throw PaletteInputError(description: "Invalid native RGB value: \(hex)")
    }
    return Color(red: UInt16((value >> 16) & 255) * 257,
                 green: UInt16((value >> 8) & 255) * 257,
                 blue: UInt16(value & 255) * 257)
}

func hex(_ color: Color) -> String {
    String(format: "#%02x%02x%02x", Int(color.red) / 257, Int(color.green) / 257, Int(color.blue) / 257)
}

guard CommandLine.arguments.count == 3 else {
    throw PaletteInputError(description: "Usage: terminal-palette LiveTerminalView.swift TerminalOptions.swift")
}
let view = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let options = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let strategyName = try one(#"ansi256PaletteStrategy:\s*\.([A-Za-z0-9]+)\s*,"#, in: options)
let strategy: Ansi256PaletteStrategy
switch strategyName {
case "xterm": strategy = .xterm
case "base16Lab": strategy = .base16Lab
case "base16LabHarmonious": strategy = .base16LabHarmonious
default: throw PaletteInputError(description: "Unknown native palette strategy: \(strategyName)")
}
let block = try one(#"static let ansiPalette:\s*\[SwiftTerm\.Color\]\s*=\s*\[(.*?)\]"#, in: view)
let base = try captures(#"ansi\(0x([0-9A-Fa-f]{6})\)"#, in: block).map(color)
guard base.count == 16 else { throw PaletteInputError(description: "Expected 16 native ANSI colors") }
let background = try color(one(#"view\.nativeBackgroundColor\s*=\s*Self\.color\(0x([0-9A-Fa-f]{6})\)"#, in: view))
let foreground = try color(one(#"view\.nativeForegroundColor\s*=\s*Self\.color\(0x([0-9A-Fa-f]{6})\)"#, in: view))
let cursor = try color(one(#"view\.caretColor\s*=\s*Self\.color\(0x([0-9A-Fa-f]{6})\)"#, in: view))
let palette = Color.setupDefaultAnsiColors(initialColors: base, strategy: strategy,
                                          backgroundColor: background, foregroundColor: foreground)
guard palette.count == 256 else { throw PaletteInputError(description: "Expected 256 native colors") }
let names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
             "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]
var theme: [String: Any] = [:]
for (index, name) in names.enumerated() { theme[name] = hex(palette[index]) }
theme["background"] = hex(background)
theme["foreground"] = hex(foreground)
theme["cursor"] = hex(cursor)
theme["extendedAnsi"] = palette.dropFirst(16).map(hex)
let json = try JSONSerialization.data(withJSONObject: theme, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write(Data([10]))
