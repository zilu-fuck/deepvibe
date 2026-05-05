package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/zilu-fuck/deepvibe/internal/server"
)

func main() {
	host := flag.String("host", "127.0.0.1", "HTTP host")
	port := flag.Int("port", 4242, "HTTP port")
	flag.Parse()

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "deepvibe-server: %v\n", err)
		os.Exit(1)
	}

	srv := server.New(server.Options{
		CWD:  cwd,
		Host: *host,
		Port: *port,
	})

	if err := srv.ListenAndServe(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "deepvibe-server: %v\n", err)
		os.Exit(1)
	}
}
