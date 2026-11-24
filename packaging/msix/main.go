// Command msix makes herdrup's Microsoft Store package (README.md,
// "Microsoft Store package"; release.yml) from the app `mygo build -platform
// windows/amd64` built with -X main.distribution=store:
//
//	go run ./packaging/msix pack -from build/windows-amd64 -stage DIR \
//	  -name NAME -publisher CN=... [-publisher-display-name NAME] [-out FILE.msix]
//
// stages the app, its logos and AppxManifest.xml in DIR and, with -out,
// packs them with the Windows SDK's makeappx, unsigned: the Store signs
// what it publishes. `go run ./packaging/msix tool NAME` prints the path of
// a Windows SDK tool, such as signtool.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "msix:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: msix pack [flags] | msix tool NAME")
	}
	switch args[0] {
	case "tool":
		if len(args) != 2 {
			return fmt.Errorf("usage: msix tool NAME")
		}
		p, err := sdkTool(args[1])
		if err != nil {
			return err
		}
		fmt.Println(p)
		return nil
	case "pack":
		flags := flag.NewFlagSet("pack", flag.ContinueOnError)
		from := flags.String("from", "build/windows-amd64", "the app as mygo build wrote it")
		dir := flags.String("stage", "", "the folder to stage the package in (replaced)")
		out := flags.String("out", "", "the package to make with makeappx; none when empty")
		icon := flags.String("icon", "resources/icon.png", "the app icon the logos are made from")
		pkg := flags.String("package", "package.json", "the package.json whose version the package has")
		var id identity
		flags.StringVar(&id.Name, "name", "", "Package/Identity/Name (Partner Center, Product identity)")
		flags.StringVar(&id.Publisher, "publisher", "", "Package/Identity/Publisher, CN=…")
		flags.StringVar(&id.PublisherDisplayName, "publisher-display-name", "", "Package/Properties/PublisherDisplayName (default "+defaultPublisherDisplayName+")")
		flags.StringVar(&id.Arch, "arch", "x64", "ProcessorArchitecture")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *dir == "" {
			return fmt.Errorf("pack: -stage is required")
		}
		if id.PublisherDisplayName == "" {
			id.PublisherDisplayName = defaultPublisherDisplayName
		}
		v, err := packageVersion(*pkg)
		if err != nil {
			return err
		}
		if id.Version, err = msixVersion(v); err != nil {
			return err
		}
		if err := stage(*from, *dir, *icon, id); err != nil {
			return err
		}
		fmt.Printf("Staged %s %s (%s, from %s) in %s\n", id.Name, id.Version, id.Publisher, v, *dir)
		if *out == "" {
			return nil
		}
		if err := pack(*dir, *out); err != nil {
			return err
		}
		fmt.Println("Packed", *out)
		return nil
	}
	return fmt.Errorf("unknown command %q: want pack or tool", args[0])
}
