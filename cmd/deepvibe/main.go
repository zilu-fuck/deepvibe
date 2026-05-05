package main

import (
	"context"
	"os"

	"github.com/zilu-fuck/deepvibe/internal/cli"
)

func main() {
	os.Exit(cli.Run(context.Background(), os.Args, os.Stdout, os.Stderr, os.Getwd))
}
