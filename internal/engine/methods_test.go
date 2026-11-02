package engine_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The engine looks every method it sends up in herdrapi.Methods and panics
// on a name the table lacks, so each name the package passes to method, do
// or call must be in the table, or the call it backs panics when used.
func TestEveryCalledMethodIsInTheTable(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var called []string
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			consts := map[string]string{}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if spec, ok := n.(*ast.ValueSpec); ok {
					for i, name := range spec.Names {
						if i < len(spec.Values) {
							if lit, ok := spec.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
								consts[name.Name], _ = strconv.Unquote(lit.Value)
							}
						}
					}
				}
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				arg := -1
				switch f := call.Fun.(type) {
				case *ast.Ident:
					if f.Name == "method" {
						arg = 0
					}
				case *ast.SelectorExpr:
					if f.Sel.Name == "do" {
						arg = 1
					}
				case *ast.IndexExpr:
					if id, ok := f.X.(*ast.Ident); ok && id.Name == "call" {
						arg = 2
					}
				}
				if arg < 0 || arg >= len(call.Args) {
					return true
				}
				switch a := call.Args[arg].(type) {
				case *ast.BasicLit:
					name, _ := strconv.Unquote(a.Value)
					called = append(called, name)
				case *ast.Ident:
					if name, ok := consts[a.Name]; ok {
						called = append(called, name)
					} else if !slices.ContainsFunc(fn.Type.Params.List, func(p *ast.Field) bool {
						return slices.ContainsFunc(p.Names, func(id *ast.Ident) bool { return id.Name == a.Name })
					}) {
						t.Errorf("%s: method name %s is neither a literal, a constant nor a parameter", fset.Position(a.Pos()), a.Name)
					}
				default:
					t.Errorf("%s: method name is not a literal", fset.Position(a.Pos()))
				}
				return true
			})
		}
	}
	if !slices.Contains(called, "agent.list") || !slices.Contains(called, "machine.status") {
		t.Fatalf("the scan missed known calls: %q", called)
	}
	for _, name := range called {
		if _, ok := herdrapi.MethodByName(name); !ok {
			t.Errorf("the engine calls %s, which is not in herdrapi.Methods", name)
		}
	}
}
