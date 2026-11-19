// Enumerate route-shaped calls with the Go parser, including multiline and dynamic calls.
package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

func main() {
	root := os.Args[1]
	fset := token.NewFileSet()
	owners := make(map[string]string)
	loaded, err := packages.Load(&packages.Config{
		Dir:  filepath.Join(root, "backend", "backend"),
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports,
		Fset: fset,
	}, "./...")
	if err != nil {
		panic(err)
	}
	if packages.PrintErrors(loaded) != 0 {
		panic("Cannot classify route receivers; package loading failed")
	}
	key := func(pos token.Pos) string {
		at := fset.Position(pos)
		return at.Filename + ":" + strconv.Itoa(at.Line) + ":" + strconv.Itoa(at.Column)
	}
	for _, pkg := range loaded {
		for _, syntax := range pkg.Syntax {
			ast.Inspect(syntax, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if object := pkg.TypesInfo.Uses[selector.Sel]; object != nil && object.Pkg() != nil {
					owners[key(call.Pos())] = object.Pkg().Path()
				}
				return true
			})
		}
	}
	rows := make([][]any, 0)
	err = filepath.WalkDir(filepath.Join(root, "backend", "backend"), func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !strings.HasSuffix(file, ".go") || strings.HasSuffix(file, "_test.go") {
			return nil
		}
		source, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			return err
		}
		render := func(node ast.Node) string {
			var b bytes.Buffer
			if err := printer.Fprint(&b, fset, node); err != nil {
				panic(err)
			}
			return b.String()
		}
		ast.Inspect(source, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch selector.Sel.Name {
			case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "Any", "Handle", "HandleFunc", "Group", "Match", "Static", "StaticFS", "StaticFile", "StaticFileFS", "NoRoute", "NoMethod", "Use":
			default:
				return true
			}
			if len(call.Args) == 0 {
				return true
			}
			owner, classified := owners[key(call.Pos())]
			if classified && owner != "github.com/gin-gonic/gin" && owner != "net/http" {
				return true
			}
			expression := render(call.Args[0])
			status := "动态表达式待解析；组前缀/注册表/运行时未核验"
			if value, ok := call.Args[0].(*ast.BasicLit); ok && value.Kind == token.STRING {
				literal, err := strconv.Unquote(value.Value)
				if err != nil {
					panic(err)
				}
				expression = literal
				status = "路由候选声明；组前缀/注册表/运行时未核验"
			}
			if !classified {
				status = "接收者类型未解析；需确认是否 HTTP 路由；运行时未核验"
			}
			relative, err := filepath.Rel(root, file)
			if err != nil {
				panic(err)
			}
			rows = append(rows, []any{selector.Sel.Name, render(selector.X), expression, filepath.ToSlash(relative), fset.Position(call.Pos()).Line, status})
			return true
		})
		return nil
	})
	if err != nil {
		panic(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(rows); err != nil {
		panic(err)
	}
}
