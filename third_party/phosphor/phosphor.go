// Package phosphor embeds the Phosphor icons (@phosphor-icons/core 2.1.1, MIT,
// LICENSE) that Windows and Linux draw in place of SF Symbols
// (app/symbols_other.go). Paths in FS are relative to this directory, e.g.
// "fill/plus-fill.svg".
package phosphor

import "embed"

//go:embed LICENSE bold fill light regular thin
var FS embed.FS
