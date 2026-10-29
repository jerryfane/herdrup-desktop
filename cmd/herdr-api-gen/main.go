// Command herdr-api-gen keeps package herdrapi's types in step with herdr's
// API schema at a pinned herdr commit.
//
//	go run ./cmd/herdr-api-gen -commit <40-char sha>   move the pin and regenerate
//	go run ./cmd/herdr-api-gen -generate               regenerate the Go types from the pinned copy
//	go run ./cmd/herdr-api-gen -check                  offline: schema hash and generated file
//	go run ./cmd/herdr-api-gen -check -upstream        also compare the pinned copy with herdr on GitHub
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/jerryfane/herdrup-desktop/internal/apigen"
)

func main() {
	root := flag.String("root", ".", "repository root")
	commit := flag.String("commit", "", "herdr commit to pin and generate from")
	generate := flag.Bool("generate", false, "regenerate the Go types from the pinned schema")
	check := flag.Bool("check", false, "verify the pinned schema and the generated Go")
	upstream := flag.Bool("upstream", false, "with -check, also compare the pinned schema with herdr on GitHub")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	switch {
	case *commit != "":
		if err := apigen.Pin(ctx, *root, *commit, apigen.GitHub{}); err != nil {
			fail(err)
		}
		fmt.Printf("pinned %s %s at %s\n", apigen.Repo, apigen.SchemaSource, *commit)
	case *generate:
		if err := apigen.Generate(*root); err != nil {
			fail(err)
		}
	case *check:
		errs := apigen.Check(*root)
		if *upstream {
			errs = append(errs, apigen.VerifyUpstream(ctx, *root, apigen.GitHub{})...)
		}
		for _, err := range errs {
			fmt.Fprintln(os.Stderr, err)
		}
		if len(errs) > 0 {
			os.Exit(1)
		}
		fmt.Println("herdr api types: ok")
	default:
		flag.Usage()
		os.Exit(2)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
