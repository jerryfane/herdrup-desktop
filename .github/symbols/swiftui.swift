// Checks Symbols.Image against SwiftUI on macOS. For every image listed in
// <dir>/go.json (written by TestSymbolDump), it lays out and renders
// Image(systemName:).font(.system(size:weight:)) at the same display scale
// and writes <dir>/swiftui.json and <dir>/swiftui/*.png: SwiftUI's frame and
// baseline, and how far its pixels are from Symbols.Image's PNG in <dir>/go.
// It fails when a frame or baseline differs.
//
//	swift .github/symbols/swiftui.swift <dir>
//
// With "explore" after <dir> it instead logs how AppKit's symbol images are
// built, for working out how SwiftUI sizes them.
import AppKit
import ImageIO
import ObjectiveC
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

func nsWeight(_ s: String) -> NSFont.Weight {
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
            && abs(r.goBaseline - r.swiftUIBaseline) < 0.001 && r.goPixels == r.swiftUIPixels
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

// MARK: - explore

func shape(_ enc: String) -> (ret: String, zeroArg: Bool) {
    let ret = String(enc.prefix { !$0.isNumber })
    let args = enc.dropFirst(ret.count).filter { !$0.isNumber }
    return (ret, args == "@:")
}

let skipWords = ["init", "dealloc", "copy", "retain", "release", "autorelease", "destruct", "dispose", "zone",
                 "new", "draw", "invalidate", "reset", "clear", "purge", "flush", "mutable", "hash", "self",
                 "superclass", "class", "description", "cgimage", "rasterize", "allowsWeakReference", "retainWeakReference",
                 "isProxy", "debugQuickLook", "encode", "archive", "data", "load"]

/// Calls every zero-argument getter of obj that returns a number, a
/// geometry struct or an object, and logs what it returns.
func dumpGetters(_ obj: AnyObject, label: String, depth: Int, seen: inout Set<ObjectIdentifier>) {
    guard !seen.contains(ObjectIdentifier(obj)) else { return }
    seen.insert(ObjectIdentifier(obj))
    var cls: AnyClass? = object_getClass(obj)
    var children: [(String, AnyObject)] = []
    while let c = cls, c != NSObject.self {
        print("\(label): class \(NSStringFromClass(c))")
        var n: UInt32 = 0
        if let ivars = class_copyIvarList(c, &n) {
            for i in 0..<Int(n) {
                let iv = ivars[i]
                let name = ivar_getName(iv).map { String(cString: $0) } ?? "?"
                let type = ivar_getTypeEncoding(iv).map { String(cString: $0) } ?? "?"
                var value = ""
                if type.hasPrefix("@"), let o = object_getIvar(obj, iv) as AnyObject? {
                    value = " = <\(NSStringFromClass(object_getClass(o)!))> \(String(describing: o).prefix(160))"
                    children.append(("\(label).\(name)", o))
                }
                print("\(label):   ivar \(name) \(type)\(value)")
            }
            free(ivars)
        }
        if let list = class_copyMethodList(c, &n) {
            for i in 0..<Int(n) {
                let m = list[i]
                let sel = method_getName(m)
                let name = NSStringFromSelector(sel)
                let enc = method_getTypeEncoding(m).map { String(cString: $0) } ?? ""
                let (ret, zeroArg) = shape(enc)
                let lower = name.lowercased()
                guard zeroArg, !name.hasPrefix("set"), !skipWords.contains(where: { lower.contains($0.lowercased()) }) else {
                    print("\(label):   method \(name) \(enc)")
                    continue
                }
                let imp = method_getImplementation(m)
                var value: String
                switch ret {
                case "{CGRect={CGPoint=dd}{CGSize=dd}}":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> CGRect).self)(obj, sel))"
                case "{CGSize=dd}":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> CGSize).self)(obj, sel))"
                case "{CGPoint=dd}":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> CGPoint).self)(obj, sel))"
                case "{NSEdgeInsets=dddd}":
                    let e = unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> NSEdgeInsets).self)(obj, sel)
                    value = "insets top \(e.top) left \(e.left) bottom \(e.bottom) right \(e.right)"
                case "d":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> Double).self)(obj, sel))"
                case "f":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> Float).self)(obj, sel))"
                case "q", "l":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> Int).self)(obj, sel))"
                case "Q", "L":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> UInt).self)(obj, sel))"
                case "i":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> Int32).self)(obj, sel))"
                case "I":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> UInt32).self)(obj, sel))"
                case "B", "c", "C":
                    value = "\(unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> Bool).self)(obj, sel))"
                case "@":
                    if let o = unsafeBitCast(imp, to: (@convention(c) (AnyObject, Selector) -> AnyObject?).self)(obj, sel) {
                        value = "<\(NSStringFromClass(object_getClass(o)!))> \(String(describing: o).prefix(160))"
                        children.append(("\(label).\(name)", o))
                    } else {
                        value = "nil"
                    }
                default:
                    print("\(label):   method \(name) \(enc)")
                    continue
                }
                print("\(label):   \(name) = \(value)")
            }
            free(list)
        }
        cls = class_getSuperclass(c)
    }
    guard depth > 0 else { return }
    for (l, o) in children {
        let name = NSStringFromClass(object_getClass(o)!)
        if ["Glyph", "Symbol", "CUI", "Vector", "Configuration"].contains(where: { name.contains($0) }) {
            dumpGetters(o, label: l, depth: depth - 1, seen: &seen)
        }
    }
}

@MainActor
func explore() {
    print("screens: \(NSScreen.screens.map { "\($0.frame.size) @\($0.backingScaleFactor)x" })")
    let cases: [(String, Double, String)] = [
        ("square.grid.2x2.fill", 21, "medium"), ("chevron.right", 12, "semibold"),
        ("exclamationmark", 10, "heavy"), ("magnifyingglass", 21, "medium"),
    ]
    for (symbol, size, weight) in cases {
        print("== \(symbol) \(size) \(weight)")
        for s in 1...3 {
            let d = swiftUIFrame(symbol, size, weight, scale: s)
            print("SwiftUI @\(s)x: \(d.width)×\(d.height) baseline \(d.height - d.baselineFromTop)")
            let cfg = NSImage.SymbolConfiguration(pointSize: size * Double(s), weight: nsWeight(weight), scale: .medium)
            let big = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)!.withSymbolConfiguration(cfg)!
            print("AppKit at \(size * Double(s)) pt: size \(big.size) alignmentRect \(big.alignmentRect) → /\(s): \(big.size.width / Double(s))×\(big.size.height / Double(s)) baseline \(big.alignmentRect.origin.y / Double(s))")
        }
        let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: nsWeight(weight), scale: .medium)
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)!.withSymbolConfiguration(cfg)!
        for s in [1.0, 2.0, 3.0] {
            let t = NSAffineTransform()
            t.scale(by: s)
            var r = NSRect.zero
            let cg = img.cgImage(forProposedRect: &r, context: nil, hints: [.ctm: t])
            print("cgImage(forProposedRect:) @\(s)x: rect \(r) image \(cg.map { "\($0.width)×\($0.height)" } ?? "nil")")
        }
        var seen = Set<ObjectIdentifier>()
        dumpGetters(img, label: "image", depth: 0, seen: &seen)
        for (i, rep) in img.representations.enumerated() {
            dumpGetters(rep, label: "rep\(i)", depth: 2, seen: &seen)
        }
    }
}

@MainActor
func main() {
    let args = CommandLine.arguments
    guard args.count >= 2 else { fatalError("usage: swiftui.swift <dir> [explore]") }
    _ = NSApplication.shared
    if args.count == 3 && args[2] == "explore" {
        explore()
    } else {
        compare(URL(fileURLWithPath: args[1]))
    }
}

MainActor.assumeIsolated { main() }
