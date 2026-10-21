// golayout prints the gc compiler's layout of the last struct type declared in a Go file, for
// every architecture go/types knows. Used as ground truth by tests/go-compiler.test.ts.
//
// Usage: golayout <file.go>...
//
// Output: one JSON line per file, in argument order:
// {"name": ..., "archs": {"amd64": {"size", "align", "fields": [{"name", "offset", "size"}]}, ...}}
// or {"error": "..."} when the file does not type-check. Files share one importer, so standard
// library packages are loaded once.
// types.SizesFor("gc", arch) implements the gc compiler's rules, including the padding added
// after a trailing zero-size field.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
)

var archs = []string{"386", "amd64", "arm", "arm64", "loong64", "mips", "mipsle", "mips64", "mips64le", "ppc64", "ppc64le", "riscv64", "s390x", "wasm"}

type field struct {
	Name   string `json:"name"`
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
}

type layout struct {
	Size   int64   `json:"size"`
	Align  int64   `json:"align"`
	Fields []field `json:"fields"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: golayout <file.go>...")
		os.Exit(2)
	}
	fset := token.NewFileSet()
	// Imported packages carry no sizes (those come from conf.Sizes), so one importer serves
	// every file and arch.
	imp := importer.ForCompiler(fset, "source", nil)
	enc := json.NewEncoder(os.Stdout)
	for _, path := range os.Args[1:] {
		out, err := layoutFile(fset, imp, path)
		if err != nil {
			out = map[string]any{"error": err.Error()}
		}
		if err := enc.Encode(out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}

func layoutFile(fset *token.FileSet, imp types.Importer, path string) (map[string]any, error) {
	file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}

	// The last struct type declared at top level, in source order.
	var last string
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.TYPE {
			continue
		}
		for _, spec := range gen.Specs {
			ts := spec.(*ast.TypeSpec)
			if _, isStruct := ts.Type.(*ast.StructType); isStruct && ts.TypeParams == nil {
				last = ts.Name.Name
			}
		}
	}
	if last == "" {
		return nil, fmt.Errorf("no struct type declared")
	}

	out := map[string]any{"name": last}
	results := map[string]layout{}
	for _, arch := range archs {
		conf := types.Config{Importer: imp, Sizes: types.SizesFor("gc", arch)}
		pkg, err := conf.Check(file.Name.Name, fset, []*ast.File{file}, nil)
		if err != nil {
			return nil, err
		}
		t := pkg.Scope().Lookup(last).Type()
		st := t.Underlying().(*types.Struct)
		sizes := conf.Sizes
		vars := make([]*types.Var, st.NumFields())
		for i := range vars {
			vars[i] = st.Field(i)
		}
		offsets := sizes.Offsetsof(vars)
		l := layout{Size: sizes.Sizeof(t), Align: sizes.Alignof(t)}
		for i, v := range vars {
			l.Fields = append(l.Fields, field{Name: v.Name(), Offset: offsets[i], Size: sizes.Sizeof(v.Type())})
		}
		results[arch] = l
	}
	out["archs"] = results
	return out, nil
}
