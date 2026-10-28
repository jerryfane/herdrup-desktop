// Command herdrup-sync keeps the design tokens and fonts the app shares
// with the herdrup iOS app in step with a pinned herdrup commit.
//
//	go run ./cmd/herdrup-sync -commit <40-char sha>   move the pin and re-sync
//	go run ./cmd/herdrup-sync -generate               regenerate CSS and Go from the pinned copy
//	go run ./cmd/herdrup-sync -check                  offline: hashes, generated files, stylesheet rules
//	go run ./cmd/herdrup-sync -check -upstream        also re-read the pinned files from GitHub
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/jerryfane/herdrup-desktop/internal/design"
)

func main() {
	root := flag.String("root", ".", "repository root")
	commit := flag.String("commit", "", "herdrup commit to pin and sync")
	generate := flag.Bool("generate", false, "regenerate the CSS and Go files from the pinned copy")
	check := flag.Bool("check", false, "verify the synced files, generated files and stylesheets")
	upstream := flag.Bool("upstream", false, "with -check, also compare the pinned files to herdrup on GitHub")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	switch {
	case *commit != "":
		if err := design.Sync(ctx, *root, *commit, design.GitHubFetcher); err != nil {
			fail(err)
		}
		fmt.Printf("synced %s at %s\n", design.Repo, *commit)
	case *generate:
		if err := design.Generate(*root); err != nil {
			fail(err)
		}
	case *check:
		errs := design.Check(*root)
		if *upstream {
			errs = append(errs, design.VerifyUpstream(ctx, *root, design.GitHubFetcher)...)
		}
		for _, err := range errs {
			fmt.Fprintln(os.Stderr, err)
		}
		if len(errs) > 0 {
			os.Exit(1)
		}
		fmt.Println("design tokens: ok")
	default:
		flag.Usage()
		os.Exit(2)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
