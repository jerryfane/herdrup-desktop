// Checks Symbols.Image against SwiftUI on macOS. For every image listed in
// <dir>/go.json (written by TestSymbolDump), it lays out and renders
// Image(systemName:).font(.system(size:weight:)) at the same display scale
// and writes <dir>/swiftui.json and <dir>/swiftui/*.png: SwiftUI's frame and
// baseline, and how far its pixels are from Symbols.Image's PNG in <dir>/go.
// It fails when a frame or baseline differs. ImageRenderer's bitmap can be
// a pixel taller than the frame; pixels are compared from the top-left.
//
//	swift .github/symbols/swiftui.swift <dir>
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

setvbuf(stdout, nil, _IOLBF, 0)

struct GoProbe: Decodable {
    let symbol: String
    let pointSize: Double
    let weight: String
    let scale: Int
    let width: Double
    let height: Double
    let baseline: Double
    let file: String
}

struct Result: Encodable {
    let symbol: String
    let pointSize: Double
    let weight: String
    let scale: Int
    let goWidth, goHeight, goBaseline: Double
    let swiftUIWidth, swiftUIHeight, swiftUIBaseline: Double
    let goPixels, swiftUIPixels: [Int]
    /// Alpha difference over the pixels both images have, 0 to 255.
    let maxAlphaDiff: Int
    let meanAlphaDiff: Double
    let pixelsOver32: Int
    let goInk, swiftUIInk: Double
}

final class Dimensions: @unchecked Sendable {
    var width = Double.nan, height = Double.nan, baselineFromTop = Double.nan
}

func fontWeight(_ s: String) -> Font.Weight {
    switch s {
    case "ultraLight": return .ultraLight
    case "thin": return .thin
    case "light": return .light
    case "regular": return .regular
    case "medium": return .medium
    case "semibold": return .semibold
    case "bold": return .bold
    case "heavy": return .heavy
    case "black": return .black
    default: fatalError("unknown weight \(s)")
    }
}

/// The alpha of every pixel, rows from the top.
func alpha(_ cg: CGImage) -> [UInt8] {
    let w = cg.width, h = cg.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    buf.withUnsafeMutableBytes { p in
        let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return stride(from: 3, to: buf.count, by: 4).map { buf[$0] }
}

func load(_ url: URL) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fatalError("cannot read \(url.path)") }
    return img
}

func save(_ img: CGImage, _ url: URL) {
    guard let dst = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fatalError("cannot write \(url.path)")
    }
    CGImageDestinationAddImage(dst, img, nil)
    guard CGImageDestinationFinalize(dst) else { fatalError("cannot write \(url.path)") }
}

/// SwiftUI's frame and baseline for the symbol on a display of scale, read
/// where an HStack aligns it with text on their first baselines.
@MainActor
func swiftUIFrame(_ symbol: String, _ size: Double, _ weight: String, scale: Int) -> Dimensions {
    let font = Font.system(size: size, weight: fontWeight(weight))
    let d = Dimensions()
    let row = HStack(alignment: .firstTextBaseline, spacing: 0) {
        Text("H").font(font)
        Image(systemName: symbol).font(font).alignmentGuide(.firstTextBaseline) { v in
            d.width = v.width
            d.height = v.height
            d.baselineFromTop = v[.firstTextBaseline]
            return v[.firstTextBaseline]
        }
    }
    let r = ImageRenderer(content: row)
    r.scale = CGFloat(scale)
    _ = r.cgImage
    return d
}

@MainActor
func swiftUIImage(_ symbol: String, _ size: Double, _ weight: String, scale: Int) -> CGImage {
    let image = Image(systemName: symbol).font(.system(size: size, weight: fontWeight(weight))).foregroundStyle(.white)
    let renderer = ImageRenderer(content: image)
    renderer.scale = CGFloat(scale)
    guard let cg = renderer.cgImage else { fatalError("SwiftUI drew nothing for \(symbol)") }
    return cg
}

@MainActor
func check(_ p: GoProbe, dir: URL) -> Result {
    let d = swiftUIFrame(p.symbol, p.pointSize, p.weight, scale: p.scale)
    let ui = swiftUIImage(p.symbol, p.pointSize, p.weight, scale: p.scale)
    save(ui, dir.appendingPathComponent("swiftui/\(p.file)"))
    let mine = load(dir.appendingPathComponent("go/\(p.file)"))
    let a = alpha(ui), b = alpha(mine)
    var maxDiff = 0, sum = 0, over = 0, n = 0
    for y in 0..<min(ui.height, mine.height) {
        for x in 0..<min(ui.width, mine.width) {
            let diff = abs(Int(a[y * ui.width + x]) - Int(b[y * mine.width + x]))
            maxDiff = max(maxDiff, diff)
            sum += diff
            n += 1
            if diff > 32 { over += 1 }
        }
    }
    return Result(
        symbol: p.symbol, pointSize: p.pointSize, weight: p.weight, scale: p.scale,
        goWidth: p.width, goHeight: p.height, goBaseline: p.baseline,
        swiftUIWidth: d.width, swiftUIHeight: d.height, swiftUIBaseline: d.height - d.baselineFromTop,
        goPixels: [mine.width, mine.height], swiftUIPixels: [ui.width, ui.height],
        maxAlphaDiff: maxDiff, meanAlphaDiff: n > 0 ? Double(sum) / Double(n) : .nan, pixelsOver32: over,
        goInk: Double(b.reduce(0) { $0 + Int($1) }) / 255, swiftUIInk: Double(a.reduce(0) { $0 + Int($1) }) / 255)
}

@MainActor
func compare(_ dir: URL) {
    try! FileManager.default.createDirectory(at: dir.appendingPathComponent("swiftui"), withIntermediateDirectories: true)
    let probes = try! JSONDecoder().decode([GoProbe].self, from: Data(contentsOf: dir.appendingPathComponent("go.json")))
    var results: [Result] = []
    var bad = 0
    print("symbol size weight @scale | Go w×h baseline | SwiftUI w×h baseline | px Go vs SwiftUI | alpha max mean >32 | ink Go SwiftUI")
    for p in probes {
        let r = check(p, dir: dir)
        results.append(r)
        let same = abs(r.goWidth - r.swiftUIWidth) < 0.001 && abs(r.goHeight - r.swiftUIHeight) < 0.001
            && abs(r.goBaseline - r.swiftUIBaseline) < 0.001
        if !same { bad += 1 }
        print(String(format: "%@ %g %@ @%dx | %.3f×%.3f %.3f | %.3f×%.3f %.3f | %@ vs %@ | %d %.2f %d | %.1f %.1f%@",
                     r.symbol, r.pointSize, r.weight, r.scale,
                     r.goWidth, r.goHeight, r.goBaseline,
                     r.swiftUIWidth, r.swiftUIHeight, r.swiftUIBaseline,
                     "\(r.goPixels)", "\(r.swiftUIPixels)",
                     r.maxAlphaDiff, r.meanAlphaDiff, r.pixelsOver32, r.goInk, r.swiftUIInk,
                     same ? "" : "  MISMATCH"))
    }
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try! enc.encode(results).write(to: dir.appendingPathComponent("swiftui.json"))
    if bad > 0 {
        print("\(bad) of \(results.count) Symbols.Image boxes differ from SwiftUI's")
        exit(1)
    }
}

@MainActor
func main() {
    let args = CommandLine.arguments
    guard args.count == 2 else { fatalError("usage: swiftui.swift <dir>") }
    _ = NSApplication.shared
    compare(URL(fileURLWithPath: args[1]))
}

MainActor.assumeIsolated { main() }
