// Prints SwiftUI's default Capsule() and RoundedRectangle(cornerRadius:) paths
// at the sizes test/continuous.test.ts checks src/continuous.ts against. Run on
// macOS (the fixture's header says which version):
//
//	swift test/swiftui-paths.swift > test/swiftui-paths.txt
//
// then put the header back.
import SwiftUI

func dump(_ label: String, _ p: Path) {
    var parts: [String] = []
    p.forEach { el in
        switch el {
        case .move(let to): parts.append(String(format: "M %.6f %.6f", to.x, to.y))
        case .line(let to): parts.append(String(format: "L %.6f %.6f", to.x, to.y))
        case .quadCurve(let to, let c): parts.append(String(format: "Q %.6f %.6f %.6f %.6f", c.x, c.y, to.x, to.y))
        case .curve(let to, let c1, let c2):
            parts.append(String(format: "C %.6f %.6f %.6f %.6f %.6f %.6f", c1.x, c1.y, c2.x, c2.y, to.x, to.y))
        case .closeSubpath: parts.append("Z")
        }
    }
    print("\(label) | \(parts.joined(separator: " "))")
}

for (w, h) in [(87.0, 43.0), (247, 43), (40, 43), (287, 42), (100, 42), (60, 30), (30, 60)] {
    dump("capsule-default \(w)x\(h)", Capsule().path(in: CGRect(x: 0, y: 0, width: w, height: h)))
}
for (w, h, r) in [(22.0, 22.0, 11.0), (22, 22, 6), (287, 65, 14), (100, 100, 14), (320, 778, 21.5), (40, 40, 10), (40, 30, 10), (100, 30, 14)] {
    dump("rrect-default \(w)x\(h) r\(r)", RoundedRectangle(cornerRadius: r).path(in: CGRect(x: 0, y: 0, width: w, height: h)))
}
